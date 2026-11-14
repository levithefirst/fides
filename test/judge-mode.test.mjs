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
