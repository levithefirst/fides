// Item 1: deterministic parsing for track-agreement-from-page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAgreement, findDates, findNoticeDays } from '../src/lib/extract.js';
import { buildSamples, samplePageBody, samplePageTitle } from '../src/lib/samples.js';

test('fixture 1: the Fides sample contract page parses fully (table + notice clause)', () => {
  const [helios] = buildSamples('2026-11-18');
  const r = extractAgreement({ title: samplePageTitle(helios.vendor), storage: samplePageBody(helios) });
  assert.equal(r.complete, true);
  assert.equal(r.fields.vendor.value, 'Helios Payroll');
  assert.equal(r.fields.endDate.value, helios.endDate);
  assert.equal(r.fields.noticeDays.value, 30);
  assert.equal(r.fields.owner.value, 'People Ops');
  assert.ok(r.fields.obligations.length >= 1 && r.fields.obligations.length <= 3);
  for (const k of ['vendor', 'endDate', 'noticeDays', 'owner']) assert.ok(r.fields[k].source.length > 3, `${k} has a quoted source`);
  assert.deepEqual(r.lowConfidence, []);
});

test('fixture 2: prose contract, word-and-digit notice, long-form date', () => {
  const storage = `<h1>Master Services Agreement</h1>
    <p>This Agreement is made between Fides Demo Corp and Brightwater Logistics Ltd.</p>
    <p>The Initial Term expires on 31 December 2027 unless renewed.</p>
    <p>Either party may terminate by giving thirty (30) days' written notice before the end of the term.</p>
    <p>The Supplier shall provide a monthly service report.</p>
    <p>Contract owner: Dana Whitfield</p>`;
  const r = extractAgreement({ title: 'Brightwater Logistics Master Services Agreement', storage });
  assert.equal(r.fields.vendor.value, 'Brightwater Logistics');
  assert.equal(r.fields.endDate.value, '2027-12-31');
  assert.equal(r.fields.endDate.confidence, 'high');
  assert.equal(r.fields.noticeDays.value, 30);
  assert.match(r.fields.noticeDays.source, /thirty \(30\) days' written notice/);
  assert.equal(r.fields.owner.value, 'Dana Whitfield');
  assert.match(r.fields.obligations[0].value, /monthly service report/);
});

test('fixture 3: DD/MM/YYYY and "notice of N days"', () => {
  const text = 'Subscription agreement with Orchid Analytics. The subscription ends on 15/03/2027. Cancellation requires a notice of 60 days. The provider must maintain 99.9% uptime.';
  const r = extractAgreement({ title: 'Subscription agreement with Orchid Analytics', text });
  assert.equal(r.fields.vendor.value, 'Orchid Analytics');
  assert.equal(r.fields.endDate.value, '2027-03-15');
  assert.equal(r.fields.noticeDays.value, 60);
  assert.ok(r.missing.includes('owner'));
});

test('fixture 4: US-style date, "at least N days before", several dates -> low confidence end date', () => {
  const text = 'Signed on March 3, 2025. Renewal pricing is reviewed on June 1, 2026 and the term renews on March 3, 2027. Give notice at least 90 days before the renewal date.';
  const r = extractAgreement({ title: 'Kestrel Cloud renewal terms', text });
  assert.equal(r.fields.noticeDays.value, 90);
  assert.ok(r.fields.endDate);
  assert.ok(['low', 'medium'].includes(r.fields.endDate.confidence));
  assert.equal(r.fields.endDate.value, '2027-03-03');
});

test('fixture 5: no dates found', () => {
  const text = 'Meeting notes. We discussed the vendor relationship with Pinecrest Media. No decisions yet.';
  const r = extractAgreement({ title: 'Pinecrest Media notes', text });
  assert.equal(r.fields.endDate, null);
  assert.equal(r.fields.noticeDays, null);
  assert.equal(r.complete, false);
  assert.ok(r.missing.includes('endDate') && r.missing.includes('noticeDays'));
});

test('fixture 6: a table-only page', () => {
  const storage = '<table><tbody><tr><th>Supplier</th><td>Juniper Print Co</td></tr><tr><th>Expiry date</th><td>2028-01-31</td></tr><tr><th>Notice period</th><td>45 days</td></tr><tr><th>Business owner</th><td>Facilities</td></tr></tbody></table>';
  const r = extractAgreement({ title: 'Print contract', storage });
  assert.deepEqual(
    [r.fields.vendor.value, r.fields.endDate.value, r.fields.noticeDays.value, r.fields.owner.value],
    ['Juniper Print Co', '2028-01-31', 45, 'Facilities']
  );
});

test('date and notice helpers', () => {
  assert.deepEqual(findDates('a 2027-02-30 b 29/02/2028 c').map((d) => d.value), ['2028-02-29']); // invalid ISO ignored
  assert.equal(findDates('due December 31st, 2026')[0].value, '2026-12-31');
  assert.equal(findNoticeDays('sixty days notice'), 60);
  assert.equal(findNoticeDays('no notice clause'), null);
});
