// QA fixes: escalate scope, claim TTL + adopt, panel Jira fallback,
// review claims, draft-brief not-found, linked-issue pagination, link-page order.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeKvs, fakeSite } from './fakes.mjs';
import { escalationKey } from '../src/lib/escalation.js';

const require = createRequire(import.meta.url);
const realApi = require('@forge/api');
const fake = fakeKvs();
let site;
mock.module('@forge/kvs', { namedExports: fake });
mock.module('@forge/api', {
  defaultExport: { asApp: () => site.client, asUser: () => site.client },
  namedExports: { route: realApi.route },
});
mock.module('@forge/resolver', { defaultExport: class { define() {} getDefinitions() { return () => {}; } } });
const actions = await import('../src/index.js');
const svc = await import('../src/services.js');
const store = await import('../src/lib/store.js');
const { createIssue, linkIssues } = await import('../src/lib/atlassian.js');

beforeEach(() => fake.kvs.data.clear());

const SOON = () => new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
const labelled = (label) => [...site.issues.values()].filter((i) => i.labels.includes(label));
const issueOf = (vendor) => labelled('fides-agreement').find((i) => i.summary.startsWith(vendor));

async function dueAgreement(input = {}) {
  return svc.createAgreement(site.client, { vendor: 'Orchid Analytics', endDate: SOON(), noticeDays: 30, ...input });
}

async function dueAgreementWithBlocker(input = {}) {
  const a = await dueAgreement(input);
  const cfg = await store.get('config');
  const b = await createIssue(site.client, {
    projectId: cfg.projectId,
    issueTypeId: cfg.issueTypeId,
    summary: 'Question: confirm seat count',
    labels: ['fides-blocker'],
  });
  await linkIssues(site.client, 'Blocks', b.key, a.issueKey);
  return { a: await store.get(`agreement:${a.issueId}`), blocker: b };
}

test('escalate-threatened-milestones with no agreement does not error on a non-agreement issue context', async () => {
  site = fakeSite();
  await actions.installed({});
  const blocker = labelled('fides-blocker')[0];
  const r = await actions.escalateThreatenedMilestones({ context: { jira: { issueKey: blocker.key } } });
  assert.equal(r.error, undefined, r.error);
  assert.ok(r.summary, r);
  assert.equal(r.created.length, 0);
  assert.ok(r.alreadyEscalated.length >= 1);
});

test('escalate-threatened-milestones still scopes when an agreement name is given', async () => {
  site = fakeSite();
  await actions.installed({});
  const miss = await actions.escalateThreatenedMilestones({
    agreement: 'NoSuchVendor',
    context: { jira: { issueKey: issueOf('Helios Payroll').key } },
  });
  assert.match(miss.error, /could not find an agreement matching "NoSuchVendor"/);
  const hit = await actions.escalateThreatenedMilestones({ agreement: 'Helios Payroll' });
  assert.equal(hit.error, undefined, hit.error);
  assert.equal(hit.resolved.vendor, 'Helios Payroll');
  assert.equal(hit.created.length, 0);
});

test('a stuck escalation creating claim does not create a duplicate; adopts the labelled issue', async () => {
  site = fakeSite();
  const { a, blocker } = await dueAgreementWithBlocker();
  const first = await svc.escalateAll(site.client, [a]);
  assert.equal(first.created.length, 1);
  const k = escalationKey(a.issueId, blocker.id);
  const issueKey = first.created[0].issueKey;
  await store.set(k, { state: 'creating', at: new Date().toISOString() });
  const before = labelled('fides-escalation').length;
  const again = await svc.escalateAll(site.client, [a]);
  assert.equal(labelled('fides-escalation').length, before, 'no duplicate escalation');
  assert.equal(again.created.length, 0);
  assert.ok(again.existing.some((e) => e.issueKey === issueKey));
  const rec = await store.get(k);
  assert.equal(rec.issueKey, issueKey);
  assert.equal(rec.state, 'done');
});

test('a stuck escalation creating claim with no issue creates nothing until the claim is released', async () => {
  site = fakeSite();
  const { a, blocker } = await dueAgreementWithBlocker();
  const k = escalationKey(a.issueId, blocker.id);
  await store.claim(k, { state: 'creating', at: new Date().toISOString() }, store.CLAIM_TTL_SECONDS);
  const stuck = await svc.escalateAll(site.client, [a]);
  assert.equal(stuck.created.length, 0);
  assert.equal(labelled('fides-escalation').length, 0);
  await store.del(k); // TTL expired
  const after = await svc.escalateAll(site.client, [a]);
  assert.equal(after.created.length, 1);
  assert.equal(labelled('fides-escalation').length, 1);
});

test('panel falls back to the issue property when KVS is cold', async () => {
  site = fakeSite();
  await actions.installed({});
  const helios = issueOf('Helios Payroll');
  const esc = labelled('fides-escalation')[0];
  fake.kvs.data.clear();
  const onAgreement = await svc.panelData(site.client, { issueId: helios.id, issueKey: helios.key });
  assert.equal(onAgreement.kind, 'agreement');
  assert.equal(onAgreement.agreement.vendor, 'Helios Payroll');
  assert.equal(onAgreement.agreement.issueKey, helios.key);
  const onEsc = await svc.panelData(site.client, { issueId: esc.id, issueKey: esc.key });
  assert.equal(onEsc.kind, 'escalation');
  assert.equal(onEsc.agreement.vendor, 'Helios Payroll');
});

test('ensureReviewIssue uses a TTL claim and adopts an existing labelled review', async () => {
  site = fakeSite();
  const a = await dueAgreement();
  const first = await svc.ensureReviewIssue(site.client, a);
  assert.equal(first.created, true);
  const reviewKey = store.keys.review(a.issueId);
  await store.set(reviewKey, { state: 'creating', at: new Date().toISOString() });
  const before = labelled('fides-review').length;
  const again = await svc.ensureReviewIssue(site.client, a);
  assert.equal(again.created, false);
  assert.equal(again.issueKey, first.issueKey);
  assert.equal(labelled('fides-review').length, before);
  const rec = await store.get(reviewKey);
  assert.equal(rec.issueKey, first.issueKey);
});

test('ensureReviewIssue does not create while a creating claim is held, then creates after release', async () => {
  site = fakeSite();
  const a = await dueAgreement();
  const reviewKey = store.keys.review(a.issueId);
  await store.claim(reviewKey, { state: 'creating', at: new Date().toISOString() }, store.CLAIM_TTL_SECONDS);
  const stuck = await svc.ensureReviewIssue(site.client, a);
  assert.equal(stuck.created, false);
  assert.equal(stuck.pending, true);
  assert.equal(labelled('fides-review').length, 0);
  await store.del(reviewKey);
  const after = await svc.ensureReviewIssue(site.client, a);
  assert.equal(after.created, true);
  assert.equal(labelled('fides-review').length, 1);
});

test('draft-brief passes pageStatus not-found through', async () => {
  site = fakeSite();
  const a = await svc.createAgreement(site.client, {
    vendor: 'Missing Page Co',
    endDate: SOON(),
    noticeDays: 30,
    confluencePageId: '9999999',
    confluenceUrl: 'https://example-site.atlassian.net/wiki/spaces/LEGAL/pages/9999999',
  });
  const b = await actions.draftBriefAction({ agreement: a.issueKey });
  assert.equal(b.ok, true);
  assert.equal(b.source.status, 'not-found');
  assert.equal(b.contractPage.status, 'not-found');
  assert.match(b.sourceLine, /no longer exists or was moved/);
});

test('findLinkedWithLabel and findBlockers return every linked match, not a 20/50 cap', async () => {
  site = fakeSite();
  const a = await dueAgreement();
  const cfg = await store.get('config');
  // 20 closed reviews (oldest) plus one open review last: a cap of 20 would
  // miss the open one and ensureReviewIssue would create a duplicate.
  for (let i = 0; i < 20; i++) {
    const r = await createIssue(site.client, {
      projectId: cfg.projectId,
      issueTypeId: cfg.issueTypeId,
      summary: `Closed review ${i}`,
      labels: ['fides-review'],
    });
    site.issues.get(r.key).statusCategory = 'done';
    site.issues.get(r.key).created = `2020-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`;
    await linkIssues(site.client, 'Relates', r.key, a.issueKey);
  }
  const open = await createIssue(site.client, {
    projectId: cfg.projectId,
    issueTypeId: cfg.issueTypeId,
    summary: 'Open review',
    labels: ['fides-review'],
  });
  site.issues.get(open.key).created = '2026-01-01T00:00:00.000Z';
  await linkIssues(site.client, 'Relates', open.key, a.issueKey);
  const reviews = await svc.findLinkedWithLabel(site.client, a.issueKey, 'fides-review');
  assert.equal(reviews.length, 21);
  assert.equal(reviews[20].key, open.key);

  for (let i = 0; i < 51; i++) {
    const b = await createIssue(site.client, {
      projectId: cfg.projectId,
      issueTypeId: cfg.issueTypeId,
      summary: `Blocker ${i}`,
      labels: ['fides-blocker'],
    });
    await linkIssues(site.client, 'Blocks', b.key, a.issueKey);
  }
  const blockers = await svc.findBlockers(site.client, a);
  assert.equal(blockers.length, 51);

  const ensured = await svc.ensureReviewIssue(site.client, a);
  assert.equal(ensured.created, false);
  assert.equal(ensured.issueKey, open.key);
  assert.equal(labelled('fides-review').length, 21);
});

test('linkPageToAgreement writes KVS only after the remote link succeeds', async () => {
  site = fakeSite();
  await actions.installed({});
  const helios = issueOf('Helios Payroll');
  const page = [...site.pages.values()].find((p) => p.title.includes('Larkspur')) || [...site.pages.values()][0];
  const rec = await store.get(`agreement:${helios.id}`);
  // Start from a record that has no page, so a failed write is visible.
  await store.saveAgreement({ ...rec, confluencePageId: null, confluenceUrl: null });
  site.state.failRemoteLink = true;
  const fail = await svc.linkPageToAgreement(site.client, { issueId: helios.id, pageRef: String(page.id) }).catch((e) => ({ ok: false, error: e.message }));
  assert.equal(fail.ok, false);
  const afterFail = await store.get(`agreement:${helios.id}`);
  assert.equal(afterFail.confluencePageId, null);
  site.state.failRemoteLink = false;
  const ok = await svc.linkPageToAgreement(site.client, { issueId: helios.id, pageRef: String(page.id) });
  assert.equal(ok.ok, true);
  const after = await store.get(`agreement:${helios.id}`);
  assert.equal(String(after.confluencePageId), String(page.id));
  assert.ok(site.issues.get(helios.key).remote.length >= 1);
});

test('escalate treats empty, "all" and "all agreements" the same, and still scopes a named vendor', async () => {
  site = fakeSite();
  await actions.installed({});
  const blocker = labelled('fides-blocker')[0];
  for (const agreement of [undefined, '', 'all', 'ALL', 'all agreements', 'All Agreements']) {
    const r = await actions.escalateThreatenedMilestones({
      agreement,
      context: { jira: { issueKey: blocker.key } },
    });
    assert.equal(r.error, undefined, `${agreement}: ${r.error}`);
    assert.equal(r.created.length, 0);
    assert.ok(r.alreadyEscalated.length >= 1, String(agreement));
  }
  const miss = await actions.escalateThreatenedMilestones({ agreement: 'NoSuchVendor' });
  assert.match(miss.error, /could not find an agreement matching "NoSuchVendor"/);
  const hit = await actions.escalateThreatenedMilestones({ agreement: 'Helios Payroll' });
  assert.equal(hit.resolved.vendor, 'Helios Payroll');
});

test('new review descriptions use the absolute notice-by date, not a frozen day count', async () => {
  site = fakeSite();
  const a = await dueAgreement();
  const rev = await svc.ensureReviewIssue(site.client, a);
  const ev = (await import('../src/lib/dates.js')).evaluate(a, (await import('../src/lib/dates.js')).todayIso());
  const text = (await import('../src/lib/atlassian.js')).adfText(site.issues.get(rev.issueKey).description);
  assert.match(text, new RegExp(`Notice-by date: ${ev.noticeBy}\\.`));
  assert.doesNotMatch(text, /day\(s\) from today/);
});

test('healReviewNoticeWording rewrites a Fides review and is idempotent; it skips non-reviews', async () => {
  site = fakeSite();
  const a = await dueAgreement();
  const rev = await svc.ensureReviewIssue(site.client, a);
  const ev = (await import('../src/lib/dates.js')).evaluate(a, (await import('../src/lib/dates.js')).todayIso());
  const { adf, adfText, updateIssue, getIssue } = await import('../src/lib/atlassian.js');
  const stale = adf.doc(adf.p(`The notice window for ${a.vendor} is open (notice window). Notice-by date: ${ev.noticeBy}, 6 day(s) from today.`));
  await updateIssue(site.client, rev.issueKey, { description: stale });
  const first = await svc.healReviewNoticeWording(site.client, rev.issueKey);
  assert.equal(first.updated, true);
  const text = adfText((await getIssue(site.client, rev.issueKey)).description);
  assert.match(text, new RegExp(`Notice-by date: ${ev.noticeBy}\\.`));
  assert.doesNotMatch(text, /day\(s\) from today/);
  const second = await svc.healReviewNoticeWording(site.client, rev.issueKey);
  assert.equal(second.updated, false);
  const skipped = await svc.healReviewNoticeWording(site.client, a.issueKey);
  assert.equal(skipped.updated, false);
  assert.equal(skipped.skipped, 'not-review');
});

test('boardData links an open review on Due and Upcoming agreements', async () => {
  site = fakeSite();
  await actions.installed({});
  const helios = issueOf('Helios Payroll');
  const larkspur = issueOf('Larkspur Facilities');
  const first = await svc.boardData(site.client, { asUser: true });
  const h = first.agreements.find((a) => a.issueKey === helios.key);
  const l0 = first.agreements.find((a) => a.issueKey === larkspur.key);
  assert.equal(h.status, 'DUE');
  assert.ok(h.openReview?.issueKey, 'Helios seed review should appear');
  assert.equal(labelled('fides-review').some((i) => i.key === h.openReview.issueKey), true);
  assert.equal(l0.openReview, undefined);

  const rec = await store.get(`agreement:${larkspur.id}`);
  const made = await svc.ensureReviewIssue(site.client, rec);
  assert.equal(made.created, true);
  const second = await svc.boardData(site.client, { asUser: true });
  const l = second.agreements.find((a) => a.issueKey === larkspur.key);
  assert.equal(l.status, 'UPCOMING');
  assert.equal(l.openReview.issueKey, made.issueKey);
});


test('list-upcoming-notices includes openReview so the agent can preview reuse vs create', async () => {
  site = fakeSite();
  await actions.installed({});
  const r = await actions.listUpcomingNotices({ days: 365 });
  const helios = r.agreements.find((a) => a.vendor === 'Helios Payroll');
  const larkspur = r.agreements.find((a) => a.vendor === 'Larkspur Facilities');
  const northwind = r.agreements.find((a) => a.vendor === 'Northwind Analytics');
  assert.ok(helios.openReview?.issueKey, helios);
  assert.equal(helios.escalations.length, 1);
  const review = labelled('fides-review').find((i) => i.links.includes(issueOf('Helios Payroll').key));
  assert.equal(helios.openReview.issueKey, review.key);
  assert.equal(larkspur.openReview, null);
  assert.equal(northwind.openReview, null);

  const rec = await store.get(`agreement:${issueOf('Larkspur Facilities').id}`);
  const made = await svc.ensureReviewIssue(site.client, rec);
  const again = await actions.listUpcomingNotices({ days: 365 });
  assert.equal(again.agreements.find((a) => a.vendor === 'Larkspur Facilities').openReview.issueKey, made.issueKey);
});

test('the agent prompt tells the agent to preview reuse vs create before CREATE actions', async () => {
  const { readFileSync } = await import('node:fs');
  const prompt = readFileSync(new URL('../static/agent/prompt.txt', import.meta.url), 'utf8');
  assert.match(prompt, /already has escalation CLSD-40, so confirming will reuse it/);
  assert.match(prompt, /already has review CLSD-41, so confirming will reuse it/);
  assert.match(prompt, /Before calling create-review-issue or escalate-threatened-milestones/);
});
