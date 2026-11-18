// Item 4: fast first paint from a per-user KVS snapshot.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeKvs, fakeSite } from './fakes.mjs';
import { deriveBoardView, freshnessText } from '../src/lib/view.js';

const fake = fakeKvs();
mock.module('@forge/kvs', { namedExports: fake });
const svc = await import('../src/services.js');
beforeEach(() => fake.kvs.data.clear());

test('a board load saves a per-user snapshot; the next open paints from it with one KVS read', async () => {
  const site = fakeSite({ latencyMs: 300 });
  await svc.judgeModeSeed(site.client, 'board-open');
  await svc.boardData(site.client, { asUser: true, accountId: 'user-a' });
  assert.equal(await svc.getSnapshot('user-b'), null, 'snapshots are per user');

  const calls = site.calls.length;
  const t0 = Date.now();
  const snap = await svc.getSnapshot('user-a');
  const ms = Date.now() - t0;
  assert.equal(site.calls.length, calls, 'no Jira or Confluence call for the cached paint');
  assert.ok(ms < 3000, `cached paint in ${ms} ms`);
  assert.equal(snap.fromSnapshot, true);
  assert.equal(snap.agreements.length, 4);
  const helios = snap.agreements.find((a) => a.vendor === 'Helios Payroll');
  assert.equal(helios.escalations.length, 1, 'Due spotlight data is in the snapshot');
  const view = deriveBoardView(snap, { rovo: true, now: Date.parse(snap.savedAt) + 4 * 60000 });
  assert.equal(view.freshness, 'Updated 4m ago, refreshing');
  assert.equal(view.spotlight.vendor, 'Helios Payroll');
});

test('a load error never overwrites the last good snapshot', async () => {
  const site = fakeSite();
  await svc.judgeModeSeed(site.client, 'board-open');
  await svc.boardData(site.client, { asUser: true, accountId: 'user-a' });
  await svc.saveSnapshot('user-a', { loadError: 'boom', agreements: [] });
  assert.equal((await svc.getSnapshot('user-a')).agreements.length, 4);
});

test('fresh data has no freshness label (no layout change, just the text)', () => {
  assert.equal(deriveBoardView({ agreements: [], seed: { state: 'done' } }).freshness, null);
  const now = Date.parse('2026-11-18T12:00:00Z');
  assert.equal(freshnessText('2026-11-18T11:59:40Z', now), 'Updated just now, refreshing');
  assert.equal(freshnessText('2026-11-18T09:00:00Z', now), 'Updated 3h ago, refreshing');
  assert.equal(freshnessText('nonsense', now), 'Refreshing');
});

test('first paint timings are logged and kept (last 20)', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (m) => logs.push(String(m));
  try {
    for (let i = 0; i < 22; i += 1) await svc.recordPaint({ ms: 1200 + i, source: 'snapshot', agreements: 4 });
  } finally {
    console.log = orig;
  }
  assert.match(logs[0], /^Fides first useful paint: 1200 ms from snapshot \(4 agreements\)$/);
  const kept = fake.kvs.data.get('metrics:paint');
  assert.equal(kept.length, 20);
  assert.equal(kept[0].ms, 1221);
});

test('cold site: no snapshot, so the seeding state shows and the first agreement appears as soon as it exists', async () => {
  const site = fakeSite({ latencyMs: 100 });
  assert.equal(await svc.getSnapshot('user-a'), null);
  let done = false;
  const seed = svc.judgeModeSeed(site.client, 'board-open').then(() => (done = true));
  let firstWith = null;
  while (!done) {
    const b = await svc.boardData(site.client, { asUser: true });
    const v = deriveBoardView(b, { seeding: true });
    assert.equal(v.mode, 'seeding');
    if (!firstWith && b.agreements.length) firstWith = b.agreements.length;
    await new Promise((r) => setTimeout(r, 30));
  }
  await seed;
  assert.ok(firstWith >= 1 && firstWith <= 4);
});
