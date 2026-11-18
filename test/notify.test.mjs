// Item 3: owner notification via Jira assignment and watchers.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeKvs, fakeSite } from './fakes.mjs';

const fake = fakeKvs();
mock.module('@forge/kvs', { namedExports: fake });
const svc = await import('../src/services.js');
const store = await import('../src/lib/store.js');
beforeEach(() => fake.kvs.data.clear());

const DANA = '5b10a2844c20165700ede21g';
const SAM = '5b10ac8d82e05b22cc7d4ef5';
const SOON = () => {
  const d = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  return d; // end date 40 days out, 30 days notice: notice-by in ~10 days (Due)
};
const issuesWith = (site, label) => [...site.issues.values()].filter((i) => i.labels.includes(label));

async function dueAgreementWithBlocker(site, input) {
  const a = await svc.createAgreement(site.client, { vendor: 'Orchid Analytics', endDate: SOON(), noticeDays: 30, ...input });
  const cfg = await store.get('config');
  const { createIssue, linkIssues } = await import('../src/lib/atlassian.js');
  const b = await createIssue(site.client, { projectId: cfg.projectId, issueTypeId: cfg.issueTypeId, summary: 'Question: confirm seat count', labels: ['fides-blocker'] });
  await linkIssues(site.client, 'Blocks', b.key, a.issueKey);
  return store.get(`agreement:${a.issueId}`);
}

test('owner picked in the form: review and escalation are assigned to the owner, owner is a watcher', async () => {
  const site = fakeSite();
  const a = await dueAgreementWithBlocker(site, { owner: 'Dana Whitfield', ownerAccountId: DANA });
  assert.equal(a.ownerAccountId, DANA);
  assert.equal(a.ownerResolution, 'picked');
  assert.equal(site.issues.get(a.issueKey).assignee, DANA, 'agreement issue assigned to the owner too');
  const rev = await svc.ensureReviewIssue(site.client, a);
  assert.equal(site.issues.get(rev.issueKey).assignee, DANA);
  assert.deepEqual(site.issues.get(rev.issueKey).watchers, [DANA]);
  assert.equal(rev.notify.via, 'owner');
  assert.equal(rev.notify.notified, true);
  const esc = await svc.escalateAll(site.client, [a]);
  const key = esc.created[0].issueKey;
  assert.equal(site.issues.get(key).assignee, DANA);
  assert.deepEqual(site.issues.get(key).watchers, [DANA]);
  assert.equal(esc.created[0].notify.via, 'owner');
  // Stored on the escalation record for the board ("Owner notified via Jira").
  const board = await svc.boardData(site.client, { asUser: true });
  assert.equal(board.agreements[0].escalations[0].notify.notified, true);
});

test('owner email resolved once at save time when user search is available', async () => {
  const site = fakeSite();
  site.state.userSearch = true;
  const a = await svc.createAgreement(site.client, { vendor: 'Juniper Print Co', endDate: '2028-01-31', noticeDays: 45, owner: 'sam@example.com' });
  assert.equal(a.ownerAccountId, SAM);
  assert.equal(a.ownerResolution, 'matched');
  const searches = site.calls.filter((c) => c.includes('/user/search')).length;
  await svc.ensureReviewIssue(site.client, a);
  assert.equal(site.calls.filter((c) => c.includes('/user/search')).length, searches, 'no lookup when notifying');
});

test('user search unavailable (no read:jira-user): falls back to the agreement assignee, and remembers', async () => {
  const site = fakeSite();
  site.state.defaultAssignee = SAM; // the project's default assignee picks up the agreement
  const a = await dueAgreementWithBlocker(site, { owner: 'dana@example.com' });
  assert.equal(a.ownerAccountId, null);
  assert.equal(a.ownerResolution, 'user-search-unavailable');
  await svc.createAgreement(site.client, { vendor: 'Second Co', endDate: '2028-01-31', noticeDays: 30, owner: 'sam@example.com' });
  assert.equal(site.calls.filter((c) => c.includes('/user/search')).length, 1, 'refusal cached, not retried per agreement');
  const rev = await svc.ensureReviewIssue(site.client, a);
  assert.equal(rev.notify.via, 'agreement-assignee');
  assert.equal(site.issues.get(rev.issueKey).assignee, SAM);
  assert.deepEqual(site.issues.get(rev.issueKey).watchers, [], 'no owner account, so no watcher');
});

test('no owner and no agreement assignee: unassigned, issue still created', async () => {
  const site = fakeSite();
  const a = await dueAgreementWithBlocker(site, {});
  const esc = await svc.escalateAll(site.client, [a]);
  assert.equal(esc.created.length, 1);
  const issue = site.issues.get(esc.created[0].issueKey);
  assert.equal(issue.assignee, null);
  assert.equal(esc.created[0].notify.via, 'unassigned');
  assert.equal(esc.created[0].notify.notified, false);
});

test('owner cannot be assigned: issue created unassigned with a clear warning, watcher still added', async () => {
  const site = fakeSite();
  const a = await dueAgreementWithBlocker(site, { owner: 'Dana', ownerAccountId: DANA });
  site.state.unassignable.add(DANA);
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    const rev = await svc.ensureReviewIssue(site.client, a);
    assert.ok(site.issues.get(rev.issueKey), 'issue exists');
    assert.equal(site.issues.get(rev.issueKey).assignee, null);
    assert.equal(rev.notify.via, 'unassigned');
    assert.equal(rev.notify.watcher, true);
    assert.equal(rev.notify.notified, true, 'the watcher still gets Jira notifications');
    assert.match(rev.notify.warnings[0], /Could not assign to the owner/);
    assert.ok(warnings.some((w) => w.includes(rev.issueKey) && /Could not assign/.test(w)), 'warning logged');
  } finally {
    console.warn = orig;
  }
});

test('account ids pasted in the owner column are used directly', async () => {
  const site = fakeSite();
  const r = await svc.importAgreements(site.client, `vendor,end date,notice days,owner\nOrchid Analytics,2027-03-15,60,${DANA}`);
  assert.equal(r.counts.created, 1);
  const [a] = await store.listAgreements();
  assert.equal(a.ownerAccountId, DANA);
  assert.equal(a.ownerResolution, 'account-id');
});
