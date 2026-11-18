// URGENT fix: sample seeding is idempotent across installs, reinstalls and
// concurrent runs, with Jira as the single source of truth.

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
mock.module('@forge/resolver', { defaultExport: class { define() {} getDefinitions() { return () => {}; } } });
const { installed, installProduct } = await import('../src/index.js');
const svc = await import('../src/services.js');
beforeEach(() => fake.kvs.data.clear());

const JIRA = { installContext: 'ari:cloud:jira::site/11111111-1111-1111-1111-111111111111' };
const CONF = { installContext: 'ari:cloud:confluence::site/11111111-1111-1111-1111-111111111111' };
const wipeStorage = () => fake.kvs.data.clear(); // uninstall, or another product's own storage
const labelled = (label) => [...site.issues.values()].filter((i) => i.labels.includes(label));
function counts() {
  return {
    agreements: labelled('fides-agreement').filter((i) => i.labels.includes('fides-sample')).length,
    blockers: labelled('fides-blocker').length,
    reviews: labelled('fides-review').length,
    escalations: labelled('fides-escalation').length,
    total: site.issues.size,
  };
}
const ONE_SET = { agreements: 4, blockers: 1, reviews: 1, escalations: 1 };
const assertOneSet = (c) => assert.deepEqual({ agreements: c.agreements, blockers: c.blockers, reviews: c.reviews, escalations: c.escalations }, ONE_SET);

test('install context is read from the ARI', () => {
  assert.equal(installProduct({}, JIRA), 'jira');
  assert.equal(installProduct({}, CONF), 'confluence');
  assert.equal(installProduct({}, {}), 'unknown');
});

test('Jira install then Confluence install (own storage) seeds exactly one set', async () => {
  site = fakeSite();
  await installed({}, JIRA);
  const after = counts();
  assertOneSet(after);
  wipeStorage(); // the Confluence install sees empty app storage
  await installed({}, CONF);
  assert.deepEqual(counts(), after, 'Confluence install created nothing in Jira');
});

test('reinstall with empty storage creates nothing new and rebuilds the board from Jira', async () => {
  site = fakeSite();
  await installed({}, JIRA);
  const before = counts();
  const firstBoard = await svc.boardData(site.client, { asUser: true });
  const helios1 = firstBoard.agreements.find((a) => a.vendor === 'Helios Payroll');

  wipeStorage(); // uninstall clears app storage
  const logs = [];
  const orig = console.log;
  console.log = (m) => logs.push(String(m));
  try {
    await installed({}, JIRA);
  } finally {
    console.log = orig;
  }
  assert.deepEqual(counts(), before, 'no new issues of any kind');
  assert.ok(logs.some((l) => /reused 4 existing sample agreement/.test(l)), logs.join('\n'));

  const board = await svc.boardData(site.client, { asUser: true });
  assert.equal(board.agreements.length, 4);
  const helios = board.agreements.find((a) => a.vendor === 'Helios Payroll');
  assert.equal(helios.issueKey, helios1.issueKey);
  assert.equal(helios.endDate, helios1.endDate);
  assert.equal(helios.noticeDays, helios1.noticeDays);
  assert.equal(helios.status, 'DUE');
  assert.equal(helios.escalations.length, 1, 'the existing escalation is re-attached, not recreated');
  assert.equal(helios.escalations[0].issueKey, firstBoard.agreements.find((a) => a.vendor === 'Helios Payroll').escalations[0].issueKey);
});

test('legacy sample issues without the issue property are rebuilt from the description', async () => {
  site = fakeSite();
  await installed({}, JIRA);
  const before = counts();
  const expected = (await svc.boardData(site.client, { asUser: true })).agreements.map((a) => [a.vendor, a.endDate, a.noticeDays]);
  for (const i of site.issues.values()) i.properties = {}; // issues created before this fix
  wipeStorage();
  await installed({}, JIRA);
  assert.deepEqual(counts(), before);
  const rebuilt = (await svc.boardData(site.client, { asUser: true })).agreements.map((a) => [a.vendor, a.endDate, a.noticeDays]);
  assert.deepEqual(rebuilt.sort(), expected.sort());
});

test('concurrent on-install runs (two Jira, one Confluence) create one set', async () => {
  site = fakeSite({ latencyMs: 30 });
  await Promise.all([installed({}, JIRA), installed({}, JIRA), installed({}, CONF)]);
  // Whichever lost the lock asked Forge to retry; let the retries run.
  await installed({ retryContext: { retryCount: 1 } }, JIRA);
  assertOneSet(counts());
});

test('escalation stays exactly one across reinstalls, scans and the agent', async () => {
  site = fakeSite();
  await installed({}, JIRA);
  for (let i = 0; i < 3; i += 1) {
    wipeStorage();
    await installed({}, JIRA);
    await installed({}, CONF);
    await svc.runScan(site.client, 'scheduledTrigger');
  }
  const actions = await import('../src/index.js');
  const r = await actions.escalateThreatenedMilestones({ agreement: 'Helios' });
  assert.equal(r.created.length, 0);
  assert.equal(r.alreadyEscalated.length, 1);
  assertOneSet(counts());
});

test('Load samples after the issues were deleted recreates exactly one set', async () => {
  site = fakeSite();
  await installed({}, JIRA);
  for (const i of [...site.issues.values()]) if (i.labels.includes('fides-sample')) site.issues.delete(i.key); // reset-samples --apply
  const r = await svc.judgeModeSeed(site.client, 'load-samples', { force: true });
  assert.equal(r.state, 'done');
  assertOneSet(counts());
  await svc.judgeModeSeed(site.client, 'load-samples', { force: true });
  assertOneSet(counts());
});
