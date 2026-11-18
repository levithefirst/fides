// Item 5: edge states. Each state shows one plain sentence and one next
// step, built from real board payloads; the board never renders blank.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeKvs, fakeSite } from './fakes.mjs';
import { deriveBoardView, ROVO_NOTE, CONFLUENCE_NOTE } from '../src/lib/view.js';

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
const svc = await import('../src/services.js');
const actions = await import('../src/index.js');
beforeEach(() => fake.kvs.data.clear());

// One sentence (ends with a full stop, no second sentence) plus a next step.
function assertSentenceAndNextStep(banner) {
  assert.ok(banner, 'a banner is shown');
  assert.ok(banner.sentence && banner.nextStep, 'sentence and next step present');
  assert.match(banner.sentence, /^[A-Z][^.]*(\.\.\.|\.)$/, `one sentence: ${banner.sentence}`);
  assert.equal(banner.text, `Next step: ${banner.nextStep}`);
  assert.doesNotMatch(banner.sentence + banner.nextStep, /—|\bRFI\b/);
}
const board = async () => svc.boardData(site.client, { asUser: true });

test('Rovo unavailable: board and scan work fully; the Ask buttons carry a short note', async () => {
  site = fakeSite();
  await svc.judgeModeSeed(site.client, 'board-open');
  const b = await board();
  const v = deriveBoardView(b, { rovo: false });
  assert.equal(v.mode, 'ready');
  assert.equal(v.rovoEnabled, false);
  assert.equal(v.rovoNote, ROVO_NOTE);
  assert.match(ROVO_NOTE, /^[^.]+\. Next step: .+\.$/);
  assert.equal(v.spotlight.escalation.issueKey.length > 0, true);
  const scan = await svc.runScan(site.client, 'manual (board)');
  assert.equal(scan.ok, true, 'scan does not depend on Rovo');
});

test('Confluence not installed: agreements and escalation seed; the board says how to link pages', async () => {
  site = fakeSite({ confluence: false });
  await svc.judgeModeSeed(site.client, 'board-open');
  const v = deriveBoardView(await board(), { rovo: true });
  assert.equal(v.mode, 'ready');
  assert.equal(v.confluenceNote, CONFLUENCE_NOTE);
  assert.match(CONFLUENCE_NOTE, /^[^.]+\. Next step: .+\.$/);
  // Unreadable page in the agent flow is explicit too.
  const r = await actions.trackAgreementFromPageAction({ page: '900001' });
  assert.equal(r.status, 'unreadable');
});

test('non-admin user: board works normally; admin-only choices become a next step', async () => {
  site = fakeSite();
  site.state.isAdmin = false;
  await svc.judgeModeSeed(site.client, 'board-open');
  const v = deriveBoardView(await board(), { rovo: true });
  assert.equal(v.mode, 'ready');
  assert.equal(v.isAdmin, false);
  assert.equal(v.canCreate, true);
  assert.equal(v.banner, null, 'nothing to warn a non-admin about');
  // Picking a project is an admin choice: a non-admin gets a next step, not a picker.
  const np = deriveBoardView({ agreements: [], seed: { state: 'needs-project' }, permissions: { isAdmin: false, canCreate: true } });
  assert.equal(np.showPicker, false);
  assertSentenceAndNextStep(np.banner);
  assert.match(np.banner.nextStep, /Ask a Jira admin/);
});

test('user without Create issues in the chosen project: read-only board with one sentence and a next step', async () => {
  site = fakeSite();
  await svc.judgeModeSeed(site.client, 'board-open'); // seeded earlier by someone who could
  site.state.canCreate = false;
  const b = await board();
  assert.equal(b.permissions.canCreate, false);
  const v = deriveBoardView(b, { rovo: true });
  assert.equal(v.mode, 'read-only');
  assert.equal(v.canCreate, false);
  assert.equal(b.agreements.length, 4, 'agreements still render');
  assertSentenceAndNextStep(v.banner);
  assert.match(v.banner.sentence, /cannot create issues in OPS/);
  // A fresh site where the user cannot create: the seed reports it, never a blank board.
  fake.kvs.data.clear();
  site = fakeSite();
  site.state.createmetaEmpty = true;
  const seed = await svc.judgeModeSeed(site.client, 'board-open');
  const v2 = deriveBoardView({ agreements: [], seed, permissions: null });
  assert.equal(v2.mode, 'no-permission');
  assertSentenceAndNextStep(v2.banner);
});

test('zero agreements: empty state with one sentence and a next step', async () => {
  site = fakeSite();
  await svc.createAgreement(site.client, { vendor: 'Real Vendor Ltd', endDate: '2030-01-01', noticeDays: 30 });
  await svc.judgeModeSeed(site.client, 'board-open'); // skipped: real data exists
  fake.kvs.data.delete([...fake.kvs.data.keys()].find((k) => k.startsWith('agreement:')));
  const v = deriveBoardView(await board(), { rovo: true });
  assert.equal(v.mode, 'empty');
  assert.equal(v.showEmpty, true);
  assertSentenceAndNextStep(v.banner);
});

test('never blank: every state has a mode and something to show', async () => {
  const payloads = [
    null,
    { loadError: 'You do not have permission to read the Fides agreement issues in Jira.', loadErrorKind: 'permission', agreements: [] },
    { loadError: 'Fides could not load the board.', loadErrorKind: 'error', loadErrorDetail: 'Jira returned 500.', agreements: [] },
    { agreements: [], seed: { state: 'no-projects' } },
    { agreements: [], seed: { state: 'error', errors: ['boom'] } },
    { agreements: [], seed: { state: 'needs-project' }, permissions: { isAdmin: true, canCreate: true } },
  ];
  for (const p of payloads) {
    const v = deriveBoardView(p, { rovo: null });
    assert.ok(v.mode);
    assert.ok(v.banner || v.showPicker || v.showEmpty, `state ${v.mode} shows something`);
    if (v.banner) assertSentenceAndNextStep(v.banner);
  }
});
