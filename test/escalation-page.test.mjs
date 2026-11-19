// Escalation descriptions must show the contract page once the agreement
// has one, including when the page was linked after the escalation existed.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeKvs, fakeSite } from './fakes.mjs';
import { adf, adfText } from '../src/lib/atlassian.js';
import { samplePageTitle } from '../src/lib/samples.js';

const fake = fakeKvs();
mock.module('@forge/kvs', { namedExports: fake });
const svc = await import('../src/services.js');
const { LABELS } = await import('../src/lib/escalation.js');

beforeEach(() => fake.kvs.data.clear());

const labelled = (site, label) => [...site.issues.values()].filter((i) => i.labels.includes(label));
const desc = (issue) => adfText(issue.description);
const writesTo = (site, from, key) =>
  site.calls.slice(from).filter((c) => c === `PUT /rest/api/3/issue/${key}` || c.startsWith(`PUT /rest/api/3/issue/${key}?`));

test('escalation created after the page is linked cites the contract URL', async () => {
  const site = fakeSite();
  await svc.judgeModeSeed(site.client, 'install');
  const esc = labelled(site, LABELS.ESCALATION);
  assert.equal(esc.length, 1);
  const helios = labelled(site, LABELS.AGREEMENT).find((i) => i.summary.startsWith('Helios Payroll'));
  const url = (await svc.visibleAgreements(site.client, { asUser: false })).find((a) => a.vendor === 'Helios Payroll').confluenceUrl;
  assert.match(url, /\/wiki\//);
  assert.match(desc(esc[0]), /Contract page:/);
  assert.match(desc(esc[0]), new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(desc(esc[0]), /not linked yet/);
  assert.ok(helios, 'helios agreement exists');
});

test('backfill heals "not linked yet" on an existing escalation, then is idempotent', async () => {
  const site = fakeSite({ confluence: false });
  await svc.judgeModeSeed(site.client, 'install');
  const esc = labelled(site, LABELS.ESCALATION);
  assert.equal(esc.length, 1);
  assert.match(desc(esc[0]), /Contract page: not linked yet/);
  const beforeKeys = [...site.issues.keys()].sort();

  site.state.confluence = true;
  const agreements = await svc.visibleAgreements(site.client, { asUser: false });
  for (const a of agreements) site.addPage({ title: samplePageTitle(a.vendor) });
  const r = await svc.backfillSamplePages(site.client);
  assert.equal(r.linked.length, 4, JSON.stringify(r.errors));
  assert.equal(labelled(site, LABELS.ESCALATION).length, 1, 'no duplicate escalation');
  assert.deepEqual([...site.issues.keys()].sort(), beforeKeys, 'no new issues');

  const helios = agreements.find((a) => a.vendor === 'Helios Payroll');
  const fresh = (await svc.visibleAgreements(site.client, { asUser: false })).find((a) => a.vendor === 'Helios Payroll');
  assert.match(desc(esc[0]), new RegExp(fresh.confluenceUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(desc(esc[0]), /not linked yet/);
  assert.ok(helios);

  const calls = site.calls.length;
  const again = await svc.backfillSamplePages(site.client);
  await svc.boardData(site.client, { asUser: true });
  await svc.runScan(site.client, 'manual (board)');
  assert.equal(again.linked.length, 0);
  assert.equal(labelled(site, LABELS.ESCALATION).length, 1);
  assert.deepEqual(writesTo(site, calls, esc[0].key), [], 'already-linked description is not written again');
});

test('scan and board open heal a stale escalation when the page is already linked', async () => {
  const site = fakeSite({ confluence: false });
  await svc.judgeModeSeed(site.client, 'install');
  site.state.confluence = true;
  const agreements = await svc.visibleAgreements(site.client, { asUser: false });
  for (const a of agreements) site.addPage({ title: samplePageTitle(a.vendor) });
  await svc.backfillSamplePages(site.client);
  const esc = labelled(site, LABELS.ESCALATION)[0];
  // Recreate the live bug: the page is linked, but the description was not rewritten.
  esc.description = adf.doc(adf.p('This open blocker may put the notice date at risk.'), adf.p('Contract page: not linked yet.'));
  const url = (await svc.visibleAgreements(site.client, { asUser: false })).find((a) => a.vendor === 'Helios Payroll').confluenceUrl;
  assert.match(desc(esc), /not linked yet/);

  const size = site.issues.size;
  await svc.boardData(site.client, { asUser: true });
  assert.equal(site.issues.size, size);
  assert.equal(labelled(site, LABELS.ESCALATION).length, 1);
  assert.match(desc(esc), new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(desc(esc), /not linked yet/);
});

test('heal never rewrites a non-escalation issue', async () => {
  const site = fakeSite({ confluence: false });
  await svc.judgeModeSeed(site.client, 'install');
  const agreement = labelled(site, LABELS.AGREEMENT).find((i) => i.summary.startsWith('Helios Payroll'));
  const original = adf.doc(adf.p('Contract page: not linked yet.'));
  agreement.description = original;
  site.state.confluence = true;
  const agreements = await svc.visibleAgreements(site.client, { asUser: false });
  for (const a of agreements) site.addPage({ title: samplePageTitle(a.vendor) });
  await svc.backfillSamplePages(site.client);
  await svc.boardData(site.client, { asUser: true });
  assert.match(desc(agreement), /Contract page: not linked yet/);
  await svc.healEscalationContractPage(site.client, agreement.key, 'https://example-site.atlassian.net/wiki/spaces/EO/pages/1');
  assert.match(desc(agreement), /Contract page: not linked yet/, 'agreement issue was not rewritten');
});

test('heal uses the agreement remote link when the property has no page URL', async () => {
  const site = fakeSite({ confluence: false });
  await svc.judgeModeSeed(site.client, 'install');
  const esc = labelled(site, LABELS.ESCALATION)[0];
  const helios = labelled(site, LABELS.AGREEMENT).find((i) => i.summary.startsWith('Helios Payroll'));
  const url = 'https://example-site.atlassian.net/wiki/spaces/EO/pages/3866625/Fides+sample+contract+Helios+Payroll';
  helios.remote.push({ url, title: 'Contract page: Helios Payroll', globalId: 'page-3866625' });
  // Property and description stay empty of a page URL, as on the live site.
  helios.properties['fides-agreement'] = { ...(helios.properties['fides-agreement'] || {}), confluencePageId: null, confluenceUrl: null };
  esc.description = adf.doc(adf.p('Contract page: not linked yet.'));
  const size = site.issues.size;
  await svc.boardData(site.client, { asUser: true });
  assert.equal(site.issues.size, size);
  assert.equal(labelled(site, LABELS.ESCALATION).length, 1);
  assert.match(desc(esc), /3866625/);
  assert.doesNotMatch(desc(esc), /not linked yet/);
});

test('new escalations describe an unresolved blocker as status: open, not To Do', async () => {
  const site = fakeSite();
  await svc.judgeModeSeed(site.client, 'install');
  const esc = labelled(site, LABELS.ESCALATION)[0];
  assert.match(desc(esc), /\(status: open\)/);
  assert.doesNotMatch(desc(esc), /\(status: To Do\)/);
});

test('heal rewrites a frozen To Do blocker status to open, only on fides-escalation issues', async () => {
  const site = fakeSite();
  await svc.judgeModeSeed(site.client, 'install');
  const esc = labelled(site, LABELS.ESCALATION)[0];
  const agreement = labelled(site, LABELS.AGREEMENT).find((i) => i.summary.startsWith('Helios Payroll'));
  esc.description = adf.doc(
    adf.p('This open blocker may put the notice date of 24 Nov at risk.'),
    adf.p('Blocker: ', adf.link('CLSD-39 Approval pending', 'https://example.atlassian.net/browse/X-2'), ' (status: To Do).'),
    adf.p('Contract page: already linked.')
  );
  agreement.description = adf.doc(adf.p('Blocker: something (status: To Do).'));
  const size = site.issues.size;
  const r = await svc.healEscalationIssue(site.client, esc.key, null);
  assert.equal(r.updated, true);
  assert.match(desc(esc), /\(status: open\)/);
  assert.doesNotMatch(desc(esc), /\(status: To Do\)/);
  assert.match(desc(agreement), /\(status: To Do\)/, 'agreement issue was not rewritten');
  const again = await svc.healEscalationIssue(site.client, esc.key, null);
  assert.equal(again.updated, false);
  assert.equal(site.issues.size, size);
  const skipped = await svc.healEscalationIssue(site.client, agreement.key, null);
  assert.equal(skipped.skipped, 'not-escalation');
});

test('opening the board heals a stale To Do blocker status on the escalation', async () => {
  const site = fakeSite();
  await svc.judgeModeSeed(site.client, 'install');
  const esc = labelled(site, LABELS.ESCALATION)[0];
  esc.description = adf.doc(adf.p('Blocker: X-2 Approval pending (status: To Do).'));
  await svc.boardData(site.client, { asUser: true });
  assert.match(desc(esc), /\(status: open\)/);
  assert.doesNotMatch(desc(esc), /\(status: To Do\)/);
});
