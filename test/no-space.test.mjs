// Clean Free Confluence site with no space at all (fides-clean, Nov 25):
// the sample pages must still be created, in one Fides space, and linked.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeKvs, fakeSite } from './fakes.mjs';

const fake = fakeKvs();
mock.module('@forge/kvs', { namedExports: fake });
const svc = await import('../src/services.js');

beforeEach(() => fake.kvs.data.clear());

test('no Confluence space: board open creates one Fides space and links all 4 sample pages', async () => {
  const site = fakeSite();
  site.state.spaces = [];
  await svc.judgeModeSeed(site.client, 'board-open');
  const bf = await svc.backfillSamplePages(site.client, { source: 'test' });
  assert.equal(site.state.spaceCreates, 1);
  assert.equal(site.state.spaces[0].key, 'FIDES');
  assert.equal(site.pages.size, 4);
  assert.equal(bf.linked.length, 4);
  const board = await svc.boardData(site.client, { asUser: true });
  assert.ok(board.agreements.every((a) => a.confluenceUrl), 'every row has a contract page');
  // Re-running creates nothing new.
  await svc.backfillSamplePages(site.client, { source: 'again' });
  assert.equal(site.state.spaceCreates, 1);
  assert.equal(site.pages.size, 4);
});

test('Jira seeded first, Confluence later with no space: install backfill heals pages', async () => {
  const site = fakeSite({ confluence: false });
  await svc.judgeModeSeed(site.client, 'install (jira)');
  assert.equal(site.pages.size, 0);
  site.state.confluence = true;
  site.state.spaces = [];
  const bf = await svc.backfillSamplePages(site.client, { source: 'install (confluence)' });
  assert.equal(bf.linked.length, 4);
  assert.equal(site.pages.size, 4);
  assert.equal(site.state.spaceCreates, 1);
});

test('nobody may create a space: no pages, no throw, a clear error per agreement', async () => {
  const site = fakeSite();
  site.state.spaces = [];
  site.state.canCreateSpace = false;
  await svc.judgeModeSeed(site.client, 'board-open');
  const bf = await svc.backfillSamplePages(site.client, { source: 'test' });
  assert.equal(site.pages.size, 0);
  assert.ok(bf.errors.some((e) => /no Confluence space/.test(e)));
});

test('Jira install trigger never creates pages (it cannot lock against the Confluence install)', async () => {
  const site = fakeSite();
  site.state.spaces = [];
  await svc.judgeModeSeed(site.client, 'install (jira)');
  const bf = await svc.backfillSamplePages(site.client, { source: 'install (jira)', createMissing: false });
  assert.equal(site.pages.size, 0);
  assert.equal(site.state.spaceCreates, 0);
  assert.equal(bf.linked.length, 0);
  const bf2 = await svc.backfillSamplePages(site.client, { source: 'install (confluence)' });
  assert.equal(bf2.linked.length, 4);
  assert.equal(site.pages.size, 4);
});
