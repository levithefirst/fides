// Install trigger (gap 2): best effort with retry and back-off while the
// app user's permissions propagate. Board open stays the guaranteed path.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeKvs, fakeSite } from './fakes.mjs';

const require = createRequire(import.meta.url);
const realApi = require('@forge/api');
const fake = fakeKvs();
let site;
mock.module('@forge/kvs', { namedExports: fake });
mock.module('@forge/api', {
  defaultExport: { asApp: () => site.client, asUser: () => site.client },
  namedExports: { route: realApi.route },
});
// Node's ESM loader exposes CJS default exports differently from the Forge
// bundler, so stub the resolver class (UI resolvers are not under test).
mock.module('@forge/resolver', {
  defaultExport: class { define() {} getDefinitions() { return () => {}; } },
});
const { installed } = await import('../src/index.js');
// A retry is an InvocationError carrying retryAfter (seconds).
const retryAfter = (r) => r?.retryAfter ?? r?.retryOptions?.retryAfter ?? r?.options?.retryAfter;

beforeEach(() => fake.kvs.data.clear());

test('permissions not ready: no seeding, no lock held, retry with back-off', async () => {
  site = fakeSite({ projects: [] }); // app user cannot see projects yet
  const r0 = await installed({});
  assert.equal(retryAfter(r0), 10);
  assert.equal(fake.kvs.data.has('lock:seed'), false, 'board open is never blocked');
  assert.equal(site.issues.size, 0);
  const r3 = await installed({ retryContext: { retryCount: 3 } });
  assert.equal(retryAfter(r3), 270);
  // After the last retry it gives up quietly; board open seeds instead.
  assert.equal(await installed({ retryContext: { retryCount: 4 } }), undefined);
});

test('permissions ready: install seeds and escalates', async () => {
  site = fakeSite();
  assert.equal(await installed({}), undefined);
  assert.equal(fake.kvs.data.get('seed').state, 'done');
  assert.equal([...site.issues.values()].filter((i) => i.labels.includes('fides-escalation')).length, 1);
});

test('Confluence install event after seeding links the sample pages', async () => {
  site = fakeSite({ confluence: false });
  await installed({}); // Jira install
  site.state.confluence = true;
  const { samplePageTitle } = await import('../src/lib/samples.js');
  for (const v of ['Helios Payroll', 'Larkspur Facilities', 'Northwind Analytics', 'Quay Support']) site.addPage({ title: samplePageTitle(v) });
  await installed({}); // Confluence install fires the same event
  const agreements = [...fake.kvs.data.entries()].filter(([k]) => k.startsWith('agreement:')).map(([, v]) => v);
  assert.equal(agreements.filter((a) => a.confluencePageId).length, 4);
  assert.equal(site.pages.size, 4);
});

test('board resolver never throws: a browse permission failure becomes a message', async () => {
  const { safeBoard } = await import('../src/index.js');
  site = fakeSite();
  await installed({});
  site.state.canBrowse = false;
  const b = await safeBoard(site.client);
  assert.deepEqual(b.agreements, [], 'JQL returns nothing for this user');
  assert.equal(b.permissions.canBrowse, false);
  const { deriveBoardView } = await import('../src/lib/view.js');
  const v = deriveBoardView(b);
  assert.equal(v.mode, 'error', 'not a misleading empty board');
  assert.equal(v.banner.sentence, 'You do not have permission to read the Fides agreement issues in Jira.');
  assert.match(v.banner.text, /^Next step: Ask a Jira admin for Browse projects/);
  // A genuine failure still becomes a message, never a throw.
  site.state.canBrowse = true;
  const orig = site.client.requestJira;
  site.client.requestJira = async () => ({ status: 500, ok: false, statusText: '500', text: async () => '{"errorMessages":["boom"]}' });
  const err = await safeBoard(site.client);
  site.client.requestJira = orig;
  assert.equal(err.loadError, 'Fides could not load the board.');
});

// ---------- gap 1: the chained Rovo ask, run through the real action handlers ----------

test('chained ask "Is Helios at risk, and what should I do?": list, escalate (idempotent), brief', async () => {
  const actions = await import('../src/index.js');
  site = fakeSite();
  await installed({}); // judge mode already escalated Helios
  const escBefore = [...site.issues.values()].filter((i) => i.labels.includes('fides-escalation'));
  assert.equal(escBefore.length, 1);

  // 1. list-upcoming-notices: Helios is Due with its open blocker and escalation.
  const list = await actions.listUpcomingNotices({ days: 60 });
  const h = list.agreements.find((a) => a.vendor === 'Helios Payroll');
  assert.equal(h.status, 'Due');
  assert.match(h.noticeByRule, /minus 30 days notice/);
  assert.equal(h.openBlockers.length, 1);
  assert.match(h.openBlockers[0].summary, /Approval pending/);
  assert.equal(h.escalations[0].issueKey, escBefore[0].key);

  // 2. escalate-threatened-milestones for Helios: reports the existing issue, creates none.
  const esc = await actions.escalateThreatenedMilestones({ agreement: 'Helios' });
  assert.equal(esc.created.length, 0);
  assert.equal(esc.alreadyEscalated[0].issueKey, escBefore[0].key);
  assert.equal([...site.issues.values()].filter((i) => i.labels.includes('fides-escalation')).length, 1);

  // 3. draft-brief: hedged options, the escalation key, the disclaimer.
  const brief = await actions.draftBriefAction({ agreement: 'Helios' });
  assert.equal(brief.ok, true);
  assert.deepEqual(brief.options.map((o) => o.option), ['Renew', 'Cancel', 'Renegotiate']);
  assert.equal(brief.escalations[0].issueKey, escBefore[0].key);
  assert.equal(brief.openBlockers.length, 1);
  assert.equal(brief.disclaimer, 'Fides tracks dates and obligations; it is not legal advice.');
  assert.ok(brief.whatAMissCouldMean.every((l) => /\bmay\b|\bcould\b/.test(l)));
});

test('agent prompt and manifest: chained ask uses only the four existing actions', async () => {
  const fs = await import('node:fs');
  const prompt = fs.readFileSync(new URL('../static/agent/prompt.txt', import.meta.url), 'utf8');
  const manifest = fs.readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
  assert.match(manifest, /- Is Helios at risk, and what should I do\?/);
  assert.match(prompt, /Is Helios at risk, and what should I do\?/);
  const order = ['list-upcoming-notices', 'escalate-threatened-milestones', 'draft-brief'].map((k) => prompt.indexOf(k, prompt.indexOf('E. "Is')));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], 'chain order: list, escalate, brief');
  const referenced = new Set(prompt.match(/\b[a-z]+(?:-[a-z]+){1,3}\b/g).filter((w) => /notices|issue|milestones|brief/.test(w)));
  const allowed = new Set(['list-upcoming-notices', 'create-review-issue', 'escalate-threatened-milestones', 'draft-brief', 'track-agreement-from-page']);
  for (const k of referenced) assert.ok(allowed.has(k), `unknown action referenced: ${k}`);
  assert.match(prompt, /Fides tracks dates and obligations; it is not legal advice\./);
  assert.doesNotMatch(prompt, /\bRFI/);
  assert.doesNotMatch(prompt + manifest, /\u2014/);
});

// ---------- gaps 5 and 6 through the real action handlers ----------

test('create-review-issue for Northwind Analytics resolves to Northwind, not Helios, and confirms the key', async () => {
  const actions = await import('../src/index.js');
  site = fakeSite();
  await installed({});
  const helios = [...site.issues.values()].find((i) => /^Helios Payroll agreement/.test(i.summary));
  const northwind = [...site.issues.values()].find((i) => /^Northwind Analytics agreement/.test(i.summary));
  // Rovo opened on the Helios issue page: context points at Helios.
  const r = await actions.createReviewIssueAction({ agreement: 'Northwind Analytics', context: { jira: { issueKey: helios.key } } });
  assert.equal(r.resolved.issueKey, northwind.key);
  assert.equal(r.resolved.vendor, 'Northwind Analytics');
  assert.match(r.resolved.confirmation, new RegExp(`to ${northwind.key} Northwind Analytics`));
  assert.match(r.agreement, /Northwind Analytics/);
  const review = site.issues.get(r.reviewIssue);
  assert.match(review.summary, /^Review: Northwind Analytics/);
  // Ambiguity is returned, not guessed.
  const amb = await actions.createReviewIssueAction({ agreement: 'Zzz Unknown Vendor' });
  assert.match(amb.error, /could not find/);
});

test('draft-brief cites the Confluence page title and link it read', async () => {
  const actions = await import('../src/index.js');
  site = fakeSite();
  await installed({});
  const b = await actions.draftBriefAction({ agreement: 'Helios Payroll' });
  assert.equal(b.source.status, 'read');
  assert.equal(b.source.title, 'Fides sample contract: Helios Payroll');
  assert.match(b.source.url, /^https:\/\/example-site\.atlassian\.net\/wiki\//);
  assert.equal(b.sourceLine, `Source: Fides sample contract: Helios Payroll (${b.source.url})`);
  assert.equal(b.resolved.vendor, 'Helios Payroll');
});

test('draft-brief says explicitly when the page cannot be read', async () => {
  const actions = await import('../src/index.js');
  site = fakeSite();
  await installed({});
  site.state.confluence = false; // the user cannot read Confluence
  const b = await actions.draftBriefAction({ agreement: 'Helios Payroll' });
  assert.equal(b.ok, true);
  assert.equal(b.source.status, 'forbidden');
  assert.match(b.sourceLine, /^Source: the linked Confluence contract page could not be read because you do not have permission/);
  assert.deepEqual(b.contractPage.excerpts, []);
  // Not linked at all is also explicit.
  site = fakeSite({ confluence: false });
  fake.kvs.data.clear();
  await installed({});
  const nb = await actions.draftBriefAction({ agreement: 'Quay' });
  assert.match(nb.sourceLine, /^Source: no Confluence contract page is linked/);
});

// ---------- item 1: track-agreement-from-page ----------

test('track-agreement-from-page: proposal first, create on confirm, idempotent per page', async () => {
  const actions = await import('../src/index.js');
  site = fakeSite();
  await installed({});
  const pageId = site.addPage({
    title: 'Brightwater Logistics Master Services Agreement',
    storage: "<p>The Initial Term expires on 31 December 2027.</p><p>Either party may terminate by giving thirty (30) days' written notice.</p><p>The Supplier shall provide a monthly service report.</p><p>Contract owner: Dana Whitfield</p>",
  });
  const url = `${site.base}/wiki/spaces/EO/pages/${pageId}`;
  const before = site.issues.size;

  const p = await actions.trackAgreementFromPageAction({ page: url });
  assert.equal(p.status, 'proposal');
  assert.equal(p.proposal.vendor.value, 'Brightwater Logistics');
  assert.equal(p.proposal.endDate.value, '2027-12-31');
  assert.match(p.proposal.noticeDays.source, /thirty \(30\) days/);
  assert.equal(site.issues.size, before, 'nothing created before confirmation');

  const c = await actions.trackAgreementFromPageAction({ page: url, confirm: true });
  assert.equal(c.status, 'created');
  const issue = site.issues.get(c.agreement.issueKey);
  assert.ok(issue.labels.includes('fides-agreement'));
  assert.equal(issue.remote.length, 1, 'remote link to the page');
  assert.ok(issue.remote[0].url.includes(`/pages/${pageId}`));

  const again = await actions.trackAgreementFromPageAction({ page: url, confirm: true });
  assert.equal(again.status, 'existing');
  assert.equal(again.agreement.issueKey, c.agreement.issueKey);
  assert.equal(site.issues.size, before + 1);
  // By title, too.
  assert.equal((await actions.trackAgreementFromPageAction({ page: 'Brightwater Logistics Master Services Agreement' })).status, 'existing');
});

test('track-agreement-from-page: "add Helios from its page" returns the existing sample agreement', async () => {
  const actions = await import('../src/index.js');
  site = fakeSite();
  await installed({});
  const r = await actions.trackAgreementFromPageAction({ page: 'Fides sample contract: Helios Payroll', confirm: true });
  assert.equal(r.status, 'existing');
  assert.equal(r.agreement.vendor, 'Helios Payroll');
});

test('track-agreement-from-page: missing fields need input; the agent can fill them', async () => {
  const actions = await import('../src/index.js');
  site = fakeSite();
  await installed({});
  const pageId = site.addPage({ title: 'Pinecrest Media notes', storage: '<p>We discussed the vendor relationship with Pinecrest Media.</p>' });
  const r = await actions.trackAgreementFromPageAction({ page: pageId, confirm: true });
  assert.equal(r.status, 'needs-input');
  assert.deepEqual(r.missing.sort(), ['endDate', 'noticeDays', 'vendor'].sort());
  const ok = await actions.trackAgreementFromPageAction({ page: pageId, confirm: true, vendor: 'Pinecrest Media', endDate: '2027-06-30', noticeDays: 60 });
  assert.equal(ok.status, 'created');
});

test('track-agreement-from-page: unreadable page says so and creates nothing', async () => {
  const actions = await import('../src/index.js');
  site = fakeSite();
  await installed({});
  const pageId = site.addPage({ title: 'Secret contract', storage: '<p>x</p>' });
  site.state.confluence = false;
  const before = site.issues.size;
  const r = await actions.trackAgreementFromPageAction({ page: pageId, confirm: true });
  assert.equal(r.status, 'unreadable');
  assert.match(r.message, /^I cannot read this page\./);
  assert.equal(site.issues.size, before);
});
