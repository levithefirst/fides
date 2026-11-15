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
  assert.match(b.loadError, /permission/);
  assert.deepEqual(b.agreements, []);
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
  const allowed = new Set(['list-upcoming-notices', 'create-review-issue', 'escalate-threatened-milestones', 'draft-brief']);
  for (const k of referenced) assert.ok(allowed.has(k), `unknown action referenced: ${k}`);
  assert.match(prompt, /Fides tracks dates and obligations; it is not legal advice\./);
  assert.doesNotMatch(prompt.replace('Never call blockers RFIs.', ''), /\bRFI/);
  assert.doesNotMatch(prompt + manifest, /\u2014/);
});
