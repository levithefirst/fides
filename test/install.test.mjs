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
