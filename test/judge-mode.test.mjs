// Offline acceptance test for judge mode (scope addendum items 1 and 4).
// Simulates a fresh site with realistic per-call latency and asserts that a
// single board open seeds the board AND creates the escalation issue well
// inside the 10-second budget, that re-running is safe, and that seeding
// skips when real data exists.
//
// Run: npm test   (uses --experimental-test-module-mocks)

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeKvs, fakeSite } from './fakes.mjs';

const fake = fakeKvs();
mock.module('@forge/kvs', { namedExports: fake });
const svc = await import('../src/services.js');
const { LABELS } = await import('../src/lib/escalation.js');

// Conservative per-request latency for Forge -> Jira/Confluence REST.
const LATENCY_MS = Number(process.env.FIDES_SIM_LATENCY_MS || 400);
const BUDGET_MS = 10_000;

beforeEach(() => fake.kvs.data.clear());

const withLabel = (site, label) => [...site.issues.values()].filter((i) => i.labels.includes(label));

test('fresh site: one board open seeds the board and escalation in under 10 s', async () => {
  const site = fakeSite({ latencyMs: LATENCY_MS });
  const t0 = Date.now();
  const seed = await svc.judgeModeSeed(site.client, 'board-open');
  const board = await svc.boardData(site.client, { asUser: true });
  const elapsed = Date.now() - t0;

  assert.equal(seed.state, 'done', JSON.stringify(seed));
  assert.equal(board.agreements.length, 4);
  assert.deepEqual(
    [board.counts.due > 0, board.counts.upcoming > 0, board.counts.onTrack > 0],
    [true, true, true]
  );
  const escalations = withLabel(site, LABELS.ESCALATION);
  assert.equal(escalations.length, 1, 'exactly one escalation issue');
  assert.equal(board.escalations.length, 1, 'escalation visible on the board');
  assert.match(escalations[0].summary, /Helios Payroll notice date .* may be at risk/);
  // Escalation links the agreement and the blocker, and the Confluence page.
  const helios = board.agreements.find((a) => a.vendor === 'Helios Payroll');
  assert.ok(escalations[0].links.includes(helios.issueKey));
  assert.ok(escalations[0].links.includes(helios.sampleBlockerKey));
  assert.ok(escalations[0].remote.some((r) => r.url.includes('/wiki/')));
  assert.equal(withLabel(site, LABELS.BLOCKER).length, 1);
  assert.doesNotMatch(JSON.stringify([...site.issues.values()]), /\bRFI\b/);

  console.log(`judge mode: ${site.calls.length} REST calls, ${elapsed} ms at ${LATENCY_MS} ms/call`);
  assert.ok(elapsed < BUDGET_MS, `took ${elapsed} ms, budget ${BUDGET_MS} ms`);
});

test('re-running is safe: no duplicate agreements, blockers or escalations', async () => {
  const site = fakeSite();
  await svc.judgeModeSeed(site.client, 'install');
  const before = site.issues.size;
  const again = await svc.judgeModeSeed(site.client, 'board-open');
  assert.equal(again.alreadyDone, true);
  await svc.runScan(site.client, 'scheduledTrigger');
  await svc.escalateAll(site.client, await (await import('../src/lib/store.js')).listAgreements());
  assert.equal(site.issues.size, before);
  assert.equal(withLabel(site, LABELS.ESCALATION).length, 1);
});

test('concurrent install trigger and board open seed once', async () => {
  const site = fakeSite({ latencyMs: 20 });
  const [a, b] = await Promise.all([
    svc.judgeModeSeed(site.client, 'install'),
    svc.judgeModeSeed(site.client, 'board-open'),
  ]);
  assert.ok([a.state, b.state].includes('running'));
  assert.equal(withLabel(site, LABELS.AGREEMENT).length, 4);
  assert.equal(withLabel(site, LABELS.ESCALATION).length, 1);
});

test('KVS cleared: Jira-side labels still prevent duplicates', async () => {
  const site = fakeSite();
  await svc.judgeModeSeed(site.client, 'install');
  const agreements = [...fake.kvs.data.entries()].filter(([k]) => k.startsWith('agreement:'));
  // Lose only the seed state and the escalation claims.
  for (const k of [...fake.kvs.data.keys()]) if (k === 'seed' || k.startsWith('esc:')) fake.kvs.data.delete(k);
  await svc.judgeModeSeed(site.client, 'board-open');
  assert.equal(withLabel(site, LABELS.AGREEMENT).length, agreements.length);
  assert.equal(withLabel(site, LABELS.ESCALATION).length, 1);
});

test('skips seeding when real agreements exist', async () => {
  const site = fakeSite();
  await svc.createAgreement(site.client, { vendor: 'Real Vendor Ltd', endDate: '2030-01-01', noticeDays: 30 });
  const r = await svc.judgeModeSeed(site.client, 'board-open');
  assert.equal(r.state, 'skipped');
  assert.equal(withLabel(site, LABELS.SAMPLE).length, 0);
});

test('closing the blocker stops further escalations; a new open blocker escalates once', async () => {
  const site = fakeSite();
  await svc.judgeModeSeed(site.client, 'install');
  const blocker = withLabel(site, LABELS.BLOCKER)[0];
  blocker.statusCategory = 'done';
  await svc.runScan(site.client, 'scheduledTrigger');
  assert.equal(withLabel(site, LABELS.ESCALATION).length, 1);
});

test('Confluence unavailable: agreements still seed, brief falls back', async () => {
  const site = fakeSite({ confluence: false });
  const seed = await svc.judgeModeSeed(site.client, 'board-open');
  assert.equal(seed.state, 'done');
  const board = await svc.boardData(site.client, { asUser: true });
  assert.equal(board.agreements.length, 4);
  assert.ok(board.agreements.every((a) => !a.confluenceUrl));
  assert.equal(withLabel(site, LABELS.ESCALATION).length, 1);
});

test('a deleted agreement issue does not blank the board', async () => {
  const site = fakeSite();
  await svc.judgeModeSeed(site.client, 'install');
  const quay = [...site.issues.values()].find((i) => i.summary.startsWith('Quay Support'));
  site.issues.delete(quay.key);
  const board = await svc.boardData(site.client, { asUser: true });
  assert.equal(board.agreements.length, 3);
});

test('explicit Load samples works even when real data exists, without duplicates', async () => {
  const site = fakeSite();
  await svc.createAgreement(site.client, { vendor: 'Real Vendor Ltd', endDate: '2030-01-01', noticeDays: 30 });
  assert.equal((await svc.judgeModeSeed(site.client, 'board-open')).state, 'skipped');
  assert.equal((await svc.judgeModeSeed(site.client, 'load-samples', { force: true })).state, 'done');
  await svc.judgeModeSeed(site.client, 'load-samples', { force: true });
  assert.equal(withLabel(site, LABELS.SAMPLE).filter((i) => i.labels.includes(LABELS.AGREEMENT)).length, 4);
  assert.equal(withLabel(site, LABELS.ESCALATION).length, 1);
});

// ---------- Confluence link backfill (gap 1 / test 4) ----------

const { samplePageTitle } = await import('../src/lib/samples.js');
const store = await import('../src/lib/store.js');

test('backfill: agreements seeded before Confluence get linked once pages appear; rerun changes nothing', async () => {
  // Jira install seeds while Confluence is not connected.
  const site = fakeSite({ confluence: false });
  await svc.judgeModeSeed(site.client, 'install');
  let agreements = await store.listAgreements();
  assert.equal(agreements.length, 4);
  assert.ok(agreements.every((a) => !a.confluencePageId));

  // Later the Confluence install creates the sample pages in another space.
  site.state.confluence = true;
  const pageIds = new Map(agreements.map((a) => [a.issueKey, site.addPage({ title: samplePageTitle(a.vendor) })]));
  const pagesBefore = site.pages.size;

  const r = await svc.backfillSamplePages(site.client);
  assert.equal(r.linked.length, 4, JSON.stringify(r.errors));
  assert.equal(r.created.length, 0, 'existing pages are reused, not recreated');
  assert.equal(site.pages.size, pagesBefore);

  agreements = await store.listAgreements();
  for (const a of agreements) {
    assert.equal(a.confluencePageId, pageIds.get(a.issueKey));
    assert.match(a.confluenceUrl, /\/wiki\/spaces\/EO\/pages\//);
    const issue = site.issues.get(a.issueKey);
    assert.equal(issue.remote.filter((l) => l.url === a.confluenceUrl).length, 1);
  }
  // The Helios escalation issue also gets the contract page link.
  const esc = withLabel(site, LABELS.ESCALATION)[0];
  assert.equal(esc.remote.length, 1);

  // Rerun: no API calls at all, nothing changes.
  const snapshot = JSON.stringify([...site.issues.values()].map((i) => i.remote));
  const callsBefore = site.calls.length;
  const again = await svc.backfillSamplePages(site.client);
  assert.equal(again.linked.length, 0);
  assert.equal(site.calls.length, callsBefore, 'rerun makes no REST calls');
  assert.equal(JSON.stringify([...site.issues.values()].map((i) => i.remote)), snapshot);
  assert.equal(site.pages.size, pagesBefore);

  // The board now shows the links.
  const board = await svc.boardData(site.client, { asUser: true });
  assert.ok(board.agreements.every((a) => a.confluenceUrl));
});

test('backfill: a lost page id is re-linked without duplicating the page or the remote link', async () => {
  const site = fakeSite();
  await svc.judgeModeSeed(site.client, 'install');
  const helios = (await store.listAgreements()).find((a) => a.vendor === 'Helios Payroll');
  const pagesBefore = site.pages.size;
  // Simulate KVS losing the link data for one agreement.
  await store.saveAgreement({ ...helios, confluencePageId: null, confluenceUrl: null });
  await store.del(store.keys.samplePage(helios.sampleKey));
  const r = await svc.backfillSamplePages(site.client);
  assert.equal(r.linked.length, 1);
  assert.equal(r.created.length, 0);
  assert.equal(site.pages.size, pagesBefore);
  const issue = site.issues.get(helios.issueKey);
  assert.equal(issue.remote.length, 1, 'globalId upsert keeps a single remote link');
});

test('backfill: creates a missing page only when Confluence confirms none exists, and only once', async () => {
  const site = fakeSite({ confluence: false });
  await svc.judgeModeSeed(site.client, 'install');
  site.state.confluence = true;
  const [a, b] = await Promise.all([svc.backfillSamplePages(site.client), svc.backfillSamplePages(site.client)]);
  assert.equal(site.pages.size, 4, 'one page per sample even with concurrent runs');
  assert.equal(a.created.length + b.created.length, 4);
  await svc.backfillSamplePages(site.client);
  assert.equal(site.pages.size, 4);
  assert.ok((await store.listAgreements()).every((x) => x.confluencePageId));
});

test('backfill: Confluence still unavailable means no change and no error spam', async () => {
  const site = fakeSite({ confluence: false });
  await svc.judgeModeSeed(site.client, 'install');
  const r = await svc.backfillSamplePages(site.client);
  assert.equal(r.linked.length, 0);
  assert.equal(r.forbidden, true);
  assert.equal(site.pages.size, 0);
});

// ---------- cold board and clean-site states (gaps 2 and 4) ----------

test('cold board: Helios Due row and its escalation are visible before seeding finishes', async () => {
  // Make one other sample slow, so "without waiting for all four" is visible.
  const site = fakeSite({
    latencyMs: 100,
    extraLatency: (_p, method, path, body) => (method === 'POST' && path === '/rest/api/3/issue' && /^Quay Support/.test(body?.fields?.summary || '') ? 3000 : 0),
  });
  let done = false;
  let firstSeen = null;
  const seedP = svc.judgeModeSeed(site.client, 'board-open').then((r) => ((done = true), r));
  while (!done) {
    const startedWhileSeeding = !done;
    const b = await svc.boardData(site.client, { asUser: true });
    const h = b.agreements.find((a) => a.vendor === 'Helios Payroll');
    if (!firstSeen && h?.escalations?.length && startedWhileSeeding) firstSeen = { agreements: b.agreements.length, h, seedFinished: done };
    await new Promise((r) => setTimeout(r, 50));
  }
  const seed = await seedP;
  assert.equal(seed.state, 'done');
  assert.ok(firstSeen, 'escalation appeared on the board while polling');
  assert.equal(firstSeen.seedFinished, false, 'escalation visible before the seed call returned');
  assert.ok(firstSeen.agreements < 4, `rendered with ${firstSeen.agreements} of 4 agreements`);
  assert.equal(firstSeen.h.openBlockers.length, 1);
  assert.match(firstSeen.h.openBlockers[0].summary, /Approval pending/);
});

test('board data: Due agreement carries computed notice-by, open blocker and one escalation', async () => {
  const site = fakeSite();
  await svc.judgeModeSeed(site.client, 'board-open');
  const b = await svc.boardData(site.client, { asUser: true });
  const h = b.agreements.find((a) => a.vendor === 'Helios Payroll');
  assert.equal(h.status, 'DUE');
  assert.ok(h.noticeBy && h.endDate && h.noticeDays);
  assert.equal(h.openBlockers.length, 1);
  assert.equal(h.escalations.length, 1);
  // Closing the blocker removes it from the row.
  [...site.issues.values()].find((i) => i.labels.includes(LABELS.BLOCKER)).statusCategory = 'done';
  const after = (await svc.boardData(site.client, { asUser: true })).agreements.find((a) => a.vendor === 'Helios Payroll');
  assert.equal(after.openBlockers.length, 0);
});

test('clean site: user who cannot create issues gets no-permission, not a blank board', async () => {
  const site = fakeSite();
  site.state.createmetaEmpty = true; // createmeta lists no creatable types
  const r = await svc.judgeModeSeed(site.client, 'board-open');
  assert.equal(r.state, 'no-permission');
  assert.match(r.message, /permission to create issues/);
  assert.equal(site.issues.size, 0);
});

test('clean site: create call rejected for permission also ends in no-permission', async () => {
  const site = fakeSite();
  site.state.canCreate = false;
  const r = await svc.judgeModeSeed(site.client, 'board-open');
  assert.equal(r.state, 'no-permission');
  // Permission granted later: the next board open seeds normally.
  site.state.canCreate = true;
  assert.equal((await svc.judgeModeSeed(site.client, 'board-open')).state, 'done');
});

test('clean site: no projects at all is reported, picker is not offered', async () => {
  const site = fakeSite({ projects: [] });
  const r = await svc.judgeModeSeed(site.client, 'board-open');
  assert.equal(r.state, 'no-projects');
});
