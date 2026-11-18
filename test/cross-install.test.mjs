// Rovo gives the same answers from the Jira and the Confluence install.
// Reproduces the live one-atlas-wptq state: Jira seeded, the Confluence
// install's app storage empty, the Helios sample page body 3 days stale,
// and the Helios issue property without the page id (remote link only).

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
const sampleAgreements = () => [...site.issues.values()].filter((i) => i.labels.includes('fides-agreement') && i.labels.includes('fides-sample'));
const issueOf = (vendor) => sampleAgreements().find((i) => i.summary.startsWith(vendor));
const pageOf = (vendor) => [...site.pages.values()].find((p) => p.title === samplePageTitle(vendor));
const count = (label) => [...site.issues.values()].filter((i) => i.labels.includes(label)).length;

// Live state: Jira seeded by the Jira install; then the Confluence install's view.
async function liveState() {
  site = fakeSite();
  await actions.installed({}, JIRA);
  const helios = issueOf('Helios Payroll');
  const prop = helios.properties['fides-agreement'];
  const page = pageOf('Helios Payroll');
  // The page was written by an earlier seed: end date 3 days earlier.
  const stale = addDays(prop.endDate, -3);
  page.storage = page.storage.split(prop.endDate).join(stale);
  // CLSD-35: the issue property never learnt the page; only the remote link exists.
  helios.properties['fides-agreement'] = { ...prop, confluencePageId: null, confluenceUrl: null };
  fake.kvs.data.clear(); // the Confluence install's own, empty storage
  return { helios, page, staleEnd: stale, liveEnd: prop.endDate, ctx: { confluence: { contentId: page.id } } };
}

test('Confluence context, empty storage: list-upcoming-notices returns all 4, Helios Due first, with its escalation', async () => {
  const { helios, ctx } = await liveState();
  const r = await actions.listUpcomingNotices({ days: 365, context: ctx });
  assert.equal(r.count, 4, JSON.stringify(r));
  assert.equal(r.agreements[0].vendor, 'Helios Payroll');
  assert.equal(r.agreements[0].issueKey, helios.key);
  assert.equal(r.agreements[0].status, 'Due');
  assert.equal(r.agreements[0].escalations.length, 1, 'escalation discovered from Jira labels');
  assert.equal(r.agreements[0].openBlockers.length, 1);
  // Default 60-day window: Due + Upcoming only.
  assert.equal((await actions.listUpcomingNotices({ context: ctx })).count, 3);
});

test('track-from-page on the stale Helios page: existing, never a new record', async () => {
  const { helios, page, staleEnd, liveEnd, ctx } = await liveState();
  const before = site.issues.size;
  const p = await actions.trackAgreementFromPageAction({ page: 'this page', context: ctx });
  assert.equal(p.status, 'existing', JSON.stringify(p));
  assert.equal(p.agreement.issueKey, helios.key);
  assert.equal(p.matchedBy, 'page');
  assert.equal(p.agreement.endDate, liveEnd, 'Jira dates, not the page dates');
  assert.match(p.pageDiffers, new RegExp(`page says the end date is ${staleEnd}`));
  const c = await actions.trackAgreementFromPageAction({ page: page.id, confirm: true, context: ctx });
  assert.equal(c.status, 'existing');
  assert.equal(c.agreement.issueKey, helios.key);
  assert.equal(site.issues.size, before, 'confirm true created nothing');
  // Adopt wrote the page onto the shared issue property and this install's storage.
  assert.equal(String(helios.properties['fides-agreement'].confluencePageId), String(page.id));
  assert.match(helios.properties['fides-agreement'].confluenceUrl, new RegExp(`/pages/${page.id}`));
  assert.equal(fake.kvs.data.get(`pageAgreement:${page.id}`).issueId, helios.id);
});

test('a different page with the same vendor and end date returns existing', async () => {
  const { helios, liveEnd } = await liveState();
  const id = site.addPage({
    title: 'Helios Payroll renewal summary',
    storage: `<table><tbody><tr><th>Vendor</th><td>Helios Payroll</td></tr><tr><th>End date</th><td>${liveEnd}</td></tr><tr><th>Notice period</th><td>30 days</td></tr></tbody></table>`,
  });
  const before = site.issues.size;
  const r = await actions.trackAgreementFromPageAction({ page: id, confirm: true });
  assert.equal(r.status, 'existing');
  assert.equal(r.matchedBy, 'vendor and end date');
  assert.equal(r.agreement.issueKey, helios.key);
  assert.equal(site.issues.size, before);
});

test('a genuinely new vendor proposes, creates one, and a second confirm returns existing', async () => {
  await liveState();
  const id = site.addPage({
    title: 'Brightwater Logistics Master Services Agreement',
    storage: "<p>The Initial Term expires on 31 December 2027.</p><p>Either party may terminate by giving thirty (30) days' written notice.</p>",
  });
  const before = site.issues.size;
  const p = await actions.trackAgreementFromPageAction({ page: id });
  assert.equal(p.status, 'proposal');
  assert.equal(site.issues.size, before);
  const c = await actions.trackAgreementFromPageAction({ page: id, confirm: true });
  assert.equal(c.status, 'created');
  assert.equal(site.issues.size, before + 1);
  assert.equal(String(site.issues.get(c.agreement.issueKey).properties['fides-agreement'].confluencePageId), String(id));
  fake.kvs.data.clear(); // even from the other install's empty storage
  const again = await actions.trackAgreementFromPageAction({ page: id, confirm: true });
  assert.equal(again.status, 'existing');
  assert.equal(again.agreement.issueKey, c.agreement.issueKey);
  assert.equal(site.issues.size, before + 1);
});

test('escalate and brief from the Confluence install: no duplicates, same keys', async () => {
  const { helios } = await liveState();
  const escKey = [...site.issues.values()].find((i) => i.labels.includes('fides-escalation')).key;
  const e = await actions.escalateThreatenedMilestones({ agreement: 'Helios' });
  assert.equal(e.created.length, 0);
  assert.equal(e.alreadyEscalated[0].issueKey, escKey);
  assert.equal(count('fides-escalation'), 1);
  const b = await actions.draftBriefAction({ agreement: 'Helios Payroll' });
  assert.equal(b.resolved.issueKey, helios.key);
  assert.equal(b.escalations[0].issueKey, escKey);
  const rv = await actions.createReviewIssueAction({ agreement: 'Helios Payroll' });
  assert.equal(rv.created, false, 'the open review is found through Jira links');
  assert.equal(count('fides-review'), 1);
});

test('Jira and Confluence installs give the same list', async () => {
  site = fakeSite();
  await actions.installed({}, JIRA);
  const jira = await actions.listUpcomingNotices({ days: 365 });
  fake.kvs.data.clear();
  const conf = await actions.listUpcomingNotices({ days: 365, context: { confluence: { contentId: '1' } } });
  const shape = (r) => r.agreements.map((a) => [a.issueKey, a.status, a.noticeBy, a.escalations.map((x) => x.issueKey).join()]);
  assert.deepEqual(shape(conf), shape(jira));
});

test('stale sample page is updated in place: same id, no second page, then left alone', async () => {
  const { helios, page, liveEnd } = await liveState();
  const pagesBefore = site.pages.size;
  const r = await svc.backfillSamplePages(site.client); // Confluence install (empty storage)
  assert.ok(r.synced.includes(helios.key), JSON.stringify(r));
  assert.equal(site.pages.size, pagesBefore, 'no second page');
  assert.ok(site.pageUpdates.includes(page.id));
  assert.equal(site.pages.get(page.id).id, page.id);
  assert.ok(site.pages.get(page.id).storage.includes(`<td>${liveEnd}</td>`));
  assert.equal(site.pages.get(page.id).version, 2);
  // Backfill linked it too: the page id is on the issue property again.
  assert.equal(String(helios.properties['fides-agreement'].confluencePageId), String(page.id));
  const updates = site.pageUpdates.length;
  await svc.backfillSamplePages(site.client);
  assert.equal(site.pageUpdates.length, updates, 'in sync: not rewritten again');
  // A non-sample page is never touched.
  assert.equal(await svc.syncSamplePage(site.client, { sample: true, confluencePageId: site.addPage({ title: 'Real contract' }), endDate: '2030-01-01', noticeDays: 30 }), 'not-a-sample-page');
});

test('seeding over a stale page from an earlier seed rewrites it in place', async () => {
  site = fakeSite();
  // An earlier seed left a page with older dates and its issues were deleted.
  site.addPage({ title: samplePageTitle('Quay Support'), storage: '<table><tbody><tr><th>End date</th><td>2027-04-14</td></tr></tbody></table>', spaceId: '777', spaceKey: 'LEGAL' });
  await actions.installed({}, JIRA);
  const quay = issueOf('Quay Support');
  const pg = pageOf('Quay Support');
  assert.equal([...site.pages.values()].filter((p) => p.title === samplePageTitle('Quay Support')).length, 1);
  assert.ok(pg.storage.includes(`<td>${quay.properties['fides-agreement'].endDate}</td>`));
});

test('linkAgreementPage writes confluencePageId onto the issue property', async () => {
  site = fakeSite({ confluence: false });
  await actions.installed({}, JIRA);
  const larkspur = issueOf('Larkspur Facilities');
  assert.equal(larkspur.properties['fides-agreement'].confluencePageId, null);
  site.state.confluence = true;
  const id = site.addPage({ title: samplePageTitle('Larkspur Facilities') });
  await svc.backfillSamplePages(site.client);
  assert.equal(String(larkspur.properties['fides-agreement'].confluencePageId), String(id));
});
