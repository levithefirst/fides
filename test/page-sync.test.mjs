// Page sync visibility and the read-only check action (2.2.0 live findings):
//  1. the sync from the Jira install was silent (and probably refused);
//  2. "Track this contract" showed a write-looking confirm card before the
//     "already tracked" answer.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeKvs, fakeSite } from './fakes.mjs';
import { addDays } from '../src/lib/dates.js';
import { samplePageTitle } from '../src/lib/samples.js';

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
const actions = await import('../src/index.js');
const svc = await import('../src/services.js');
beforeEach(() => fake.kvs.data.clear());

const JIRA = { installContext: 'ari:cloud:jira::site/1' };
const CONF = { installContext: 'ari:cloud:confluence::site/1' };
const issueOf = (vendor) => [...site.issues.values()].find((i) => i.labels.includes('fides-sample') && i.labels.includes('fides-agreement') && i.summary.startsWith(vendor));
const pageOf = (vendor) => [...site.pages.values()].find((p) => p.title === samplePageTitle(vendor));
// Writes: anything that is not a read (search and bulk fetch are POST reads).
const writes = (from = 0) => site.calls.slice(from).filter((c) => /^(POST|PUT|DELETE) /.test(c) && !/\/search\/jql$|\/issue\/bulkfetch$/.test(c));

function capture(fn) {
  const lines = [];
  const o = { log: console.log, warn: console.warn };
  console.log = (m) => lines.push(`LOG ${m}`);
  console.warn = (m) => lines.push(`WARN ${m}`);
  return fn().then((r) => ({ r, lines })).finally(() => Object.assign(console, o));
}

// The live state: Jira seeded, Confluence install's storage empty, sample
// pages 3 days stale, Helios property without the page.
async function liveState() {
  site = fakeSite();
  await actions.installed({}, JIRA);
  const helios = issueOf('Helios Payroll');
  const prop = helios.properties['fides-agreement'];
  const page = pageOf('Helios Payroll');
  for (const v of ['Helios Payroll', 'Larkspur Facilities', 'Northwind Analytics', 'Quay Support']) {
    const p = pageOf(v);
    const end = issueOf(v).properties['fides-agreement'].endDate;
    p.storage = p.storage.split(end).join(addDays(end, -3));
  }
  helios.properties['fides-agreement'] = { ...prop, confluencePageId: null, confluenceUrl: null };
  fake.kvs.data.clear();
  return { helios, page, liveEnd: prop.endDate };
}

test('sync from the Jira install: Confluence refused is logged clearly, cached for an hour, and never breaks the board', async () => {
  const { helios } = await liveState();
  site.state.confluence = false; // what the Jira install sees
  const a = await capture(() => svc.backfillSamplePages(site.client, { source: 'board (jira)' }));
  assert.equal(a.r.synced.length, 0);
  assert.equal(a.r.syncErrors.length, 4);
  assert.ok(a.lines.some((l) => /^LOG Fides page sync \(board \(jira\)\): start, 4 sample page/.test(l)), a.lines.join('\n'));
  assert.ok(a.lines.some((l) => /^WARN Fides page sync \(board \(jira\)\): failed for [A-Z]+-\d+, page \d+: HTTP 403/.test(l)));
  assert.ok(a.lines.some((l) => /every page failed, so Confluence calls look unavailable from this install; will retry after/.test(l)));
  // Second call: skipped, no Confluence calls at all.
  const calls = site.calls.length;
  const b = await capture(() => svc.backfillSamplePages(site.client, { source: 'board (jira)' }));
  assert.match(b.r.syncSkipped, /failed recently from this install/);
  assert.ok(b.lines.some((l) => /^LOG Fides page sync \(board \(jira\)\): skipped\./.test(l)));
  assert.equal(site.calls.slice(calls).filter((c) => c.includes('/wiki/')).length, 0, 'no repeated failing Confluence calls');
  // The board still works.
  const board = await svc.boardData(site.client, { asUser: true });
  assert.equal(board.agreements.length, 4);
  assert.equal(helios.key.length > 0, true);
});

test('sync from the Confluence install: start, updated and done are logged, pages updated in place', async () => {
  const { page, liveEnd } = await liveState();
  const { r, lines } = await capture(() => svc.backfillSamplePages(site.client, { source: 'daily (confluence)' }));
  assert.equal(r.synced.length, 4);
  assert.ok(lines.some((l) => /^LOG Fides page sync \(daily \(confluence\)\): start, 4 sample page/.test(l)));
  assert.ok(lines.some((l) => /updated page \d+ for [A-Z]+-\d+ in place/.test(l)));
  assert.ok(lines.some((l) => /done, updated=4 inSync=0 failed=0/.test(l)));
  assert.equal(site.pages.get(page.id).version, 2);
  assert.ok(site.pages.get(page.id).storage.includes(`<td>${liveEnd}</td>`));
  const again = await capture(() => svc.backfillSamplePages(site.client, { source: 'daily (confluence)' }));
  assert.ok(again.lines.some((l) => /done, updated=0 inSync=4 failed=0/.test(l)));
});

test('daily trigger: Confluence install syncs pages and creates no reviews; the product is logged', async () => {
  await liveState();
  const reviews = [...site.issues.values()].filter((i) => i.labels.includes('fides-review')).length;
  const { lines } = await capture(() => actions.dailyScan({}, CONF));
  assert.ok(lines.includes('LOG Fides daily trigger: product=confluence'));
  assert.ok(lines.some((l) => /Fides daily \(confluence\): linked=\d+ pagesSynced=4/.test(l)));
  assert.equal([...site.issues.values()].filter((i) => i.labels.includes('fides-review')).length, reviews);
  // First-argument context (the documented scheduledTrigger shape) is read too.
  const c = await capture(() => actions.dailyScan({ context: CONF }, undefined));
  assert.ok(c.lines.includes('LOG Fides daily trigger: product=confluence'));
});

test('check-agreement-from-page is read-only: "already tracked as CLSD-x" with zero writes', async () => {
  const { helios, page } = await liveState();
  const propBefore = JSON.stringify(helios.properties);
  const start = site.calls.length;
  const r = await actions.checkAgreementFromPageAction({ page: 'this page', context: { confluence: { contentId: page.id } } });
  assert.equal(r.status, 'existing');
  assert.equal(r.readOnly, true);
  assert.equal(r.agreement.issueKey, helios.key);
  assert.match(r.message, new RegExp(`already tracked as ${helios.key} Helios Payroll`));
  assert.equal(r.pageStale, true, 'the stale sample page is reported');
  assert.match(r.syncOffer, /Ask the user whether to update the page/);
  assert.deepEqual(writes(start), [], 'no writes');
  assert.equal(JSON.stringify(helios.properties), propBefore);
  assert.equal(site.pages.get(page.id).version || 1, 1);
});

test('check-agreement-from-page for a new vendor proposes and writes nothing', async () => {
  await liveState();
  const id = site.addPage({ title: 'Brightwater Logistics Master Services Agreement', storage: "<p>The Initial Term expires on 31 December 2027.</p><p>Either party may terminate by giving thirty (30) days' written notice.</p>" });
  const start = site.calls.length;
  const issues = site.issues.size;
  const r = await actions.checkAgreementFromPageAction({ page: id });
  assert.equal(r.status, 'proposal');
  assert.equal(r.proposal.vendor.value, 'Brightwater Logistics');
  assert.deepEqual(writes(start), []);
  assert.equal(site.issues.size, issues);
});

test('pressing Confirm on a confirm:false call creates and writes nothing', async () => {
  const { helios, page } = await liveState();
  const id = site.addPage({ title: 'Brightwater Logistics Master Services Agreement', storage: "<p>The Initial Term expires on 31 December 2027.</p><p>Either party may terminate by giving thirty (30) days' written notice.</p>" });
  const issues = site.issues.size;
  const start = site.calls.length;
  // track-agreement-from-page with confirm false, existing page and new page.
  const a = await actions.trackAgreementFromPageAction({ page: page.id, confirm: false });
  const b = await actions.trackAgreementFromPageAction({ page: id, confirm: false });
  assert.equal(a.status, 'existing');
  assert.equal(a.agreement.issueKey, helios.key);
  assert.equal(b.status, 'proposal');
  assert.deepEqual(writes(start), [], 'no issue, link, property or page writes');
  assert.equal(site.issues.size, issues);
  assert.equal(helios.properties['fides-agreement'].confluencePageId, null, 'not adopted without confirm');
  assert.equal(site.pages.get(page.id).version || 1, 1);
  assert.equal([...fake.kvs.data.keys()].some((k) => k.startsWith('pageAgreement:')), false);
});

test('confirm true on the already-tracked stale sample page: nothing created, page updated in place, link recorded', async () => {
  const { helios, page, liveEnd } = await liveState();
  const issues = site.issues.size;
  const pages = site.pages.size;
  const { r, lines } = await capture(() => actions.trackAgreementFromPageAction({ page: page.id, confirm: true }));
  assert.equal(r.status, 'existing');
  assert.equal(r.pageSynced, 'updated');
  assert.match(r.message, /The page dates were updated to match Jira\./);
  assert.equal(site.issues.size, issues, 'no new issue');
  assert.equal(site.pages.size, pages, 'no new page');
  assert.equal(site.pages.get(page.id).version, 2);
  assert.ok(site.pages.get(page.id).storage.includes(`<td>${liveEnd}</td>`));
  assert.equal(String(helios.properties['fides-agreement'].confluencePageId), String(page.id));
  assert.ok(lines.some((l) => /Fides page sync \(rovo confirm\): updated page/.test(l)));
  // Asking again: not stale any more, so no write offer.
  const again = await actions.checkAgreementFromPageAction({ page: page.id });
  assert.equal(again.pageStale, false);
  assert.equal(again.syncOffer, undefined);
});

test('confirm true when the user cannot edit the page: still existing, with a plain note', async () => {
  const { page } = await liveState();
  const orig = site.client.requestConfluence;
  site.client.requestConfluence = (path, opts) =>
    opts?.method === 'PUT' ? Promise.resolve({ status: 403, ok: false, statusText: '403', text: async () => '{"message":"No permission"}' }) : orig(path, opts);
  const r = await actions.trackAgreementFromPageAction({ page: page.id, confirm: true });
  site.client.requestConfluence = orig;
  assert.equal(r.status, 'existing');
  assert.equal(r.pageSynced, 'failed');
  assert.match(r.message, /could not be updated \(you may not have edit permission/);
});

test('manifest: the check action is GET (no confirmation card), the write action is CREATE, both on the agent', async () => {
  const fs = await import('node:fs');
  const m = fs.readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
  const block = (key) => m.slice(m.indexOf(`- key: ${key}\n      name:`), m.indexOf('inputs:', m.indexOf(`- key: ${key}\n      name:`)));
  assert.match(block('check-agreement-from-page'), /actionVerb: GET/);
  assert.match(block('track-agreement-from-page'), /actionVerb: CREATE/);
  const agent = m.slice(m.indexOf('rovo:agent:'), m.indexOf('\n  action:'));
  assert.match(agent, /- check-agreement-from-page/);
  assert.match(agent, /- track-agreement-from-page/);
  const prompt = fs.readFileSync(new URL('../static/agent/prompt.txt', import.meta.url), 'utf8');
  assert.match(prompt, /Call check-agreement-from-page with the page link/);
  assert.match(prompt, /Never call track-agreement-from-page with confirm false/);
});
