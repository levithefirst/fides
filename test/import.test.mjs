// Item 2: paste-rows import.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeKvs, fakeSite } from './fakes.mjs';
import { parseImport, normaliseDate, splitLine, MAX_ROWS } from '../src/lib/importRows.js';

const fake = fakeKvs();
mock.module('@forge/kvs', { namedExports: fake });
const svc = await import('../src/services.js');
beforeEach(() => fake.kvs.data.clear());

const TSV = [
  'Vendor\tEnd date\tNotice days\tOwner\tConfluence page',
  'Orchid Analytics\t2027-03-15\t60\tdana@example.com\t',
  'Juniper Print Co\t31/01/2028\t45\tFacilities\thttps://example-site.atlassian.net/wiki/spaces/EO/pages/123/Juniper',
].join('\n');

test('tab-separated paste with a header row', () => {
  const r = parseImport(TSV);
  assert.equal(r.ok, true);
  assert.equal(r.delimiter, 'tab');
  assert.equal(r.counts.valid, 2);
  assert.deepEqual(r.rows.map((x) => [x.vendor, x.endDate, x.noticeDays, x.owner]), [
    ['Orchid Analytics', '2027-03-15', 60, 'dana@example.com'],
    ['Juniper Print Co', '2028-01-31', 45, 'Facilities'],
  ]);
  assert.match(r.rows[1].confluenceUrl, /pages\/123/);
});

test('comma-separated with quoted cells, header in any order and case', () => {
  const csv = 'notice period,SUPPLIER,expiry\n30,"Quill & Co, Ltd",2027-09-30\n90,"Say ""Hi"" Media",01/12/2027';
  const r = parseImport(csv);
  assert.equal(r.delimiter, 'comma');
  assert.equal(r.rows[0].vendor, 'Quill & Co, Ltd');
  assert.equal(r.rows[1].vendor, 'Say "Hi" Media');
  assert.equal(r.rows[1].endDate, '2027-12-01');
  assert.deepEqual(splitLine('a, "b, c" ,d', ','), ['a', 'b, c', 'd']);
});

test('date formats: ISO and DD/MM/YYYY accepted; invalid dates and month-first rejected', () => {
  assert.equal(normaliseDate('2027-03-15'), '2027-03-15');
  assert.equal(normaliseDate('15/03/2027'), '2027-03-15');
  assert.equal(normaliseDate('5/3/2027'), '2027-03-05');
  assert.equal(normaliseDate('29/02/2028'), '2028-02-29');
  assert.equal(normaliseDate('29/02/2027'), null);
  assert.equal(normaliseDate('2027-02-30'), null);
  assert.equal(normaliseDate('03/15/2027'), null, 'month 15 is invalid, so US order is not silently accepted');
  assert.equal(normaliseDate('March 2027'), null);
});

test('per-row validation errors in the preview', () => {
  const r = parseImport('vendor,end date,notice days\n,2027-01-01,30\nAcme Widgets,2027-13-01,30\nBeta Tools,2027-01-01,ten\nGood Co,2027-01-01,30');
  assert.deepEqual(r.rows.map((x) => x.errors.length > 0), [true, true, true, false]);
  assert.match(r.rows[0].errors[0], /Vendor is empty/);
  assert.match(r.rows[1].errors[0], /not a valid/);
  assert.match(r.rows[2].errors[0], /whole number/);
  assert.equal(parseImport('name,date\nx,y').ok, false, 'missing required columns');
});

test('duplicates: by vendor plus end date, within the paste and against existing', () => {
  const existing = [{ vendor: 'Helios Payroll', endDate: '2027-01-01' }];
  const r = parseImport('vendor,end date,notice days\nhelios  payroll,2027-01-01,30\nNew Co,2027-05-05,30\nNEW CO,2027-05-05,15\nNew Co,2027-06-06,30', existing);
  assert.match(r.rows[0].duplicate, /Already tracked/);
  assert.equal(r.rows[1].duplicate, null);
  assert.match(r.rows[2].duplicate, /Repeated/);
  assert.equal(r.rows[3].duplicate, null, 'same vendor, different end date is not a duplicate');
  assert.equal(r.counts.valid, 2);
});

test(`cap at ${MAX_ROWS} rows`, () => {
  const lines = ['vendor,end date,notice days', ...Array.from({ length: 105 }, (_, i) => `Vendor ${i},2027-01-01,30`)];
  const r = parseImport(lines.join('\n'));
  assert.equal(r.truncated, true);
  assert.equal(r.counts.valid, MAX_ROWS);
  assert.match(r.rows[100].errors[0], /100-row limit/);
});

test('import: creates through the add-agreement path, skips duplicates, reports partial failure', async () => {
  const site = fakeSite();
  await svc.createAgreement(site.client, { vendor: 'Already Here Ltd', endDate: '2027-02-02', noticeDays: 30 });
  site.state.failCreateFor = /^Broken Vendor/;
  const text = [
    'vendor,end date,notice days,owner',
    'Orchid Analytics,2027-03-15,60,Dana',
    'Already Here Ltd,02/02/2027,30,',
    'Broken Vendor,2027-04-04,30,',
    'Bad Date Co,2027-99-01,30,',
    'Juniper Print Co,31/01/2028,45,Facilities',
  ].join('\n');
  const r = await svc.importAgreements(site.client, text);
  assert.deepEqual(r.results.map((x) => x.status), ['created', 'skipped', 'failed', 'failed', 'created']);
  assert.deepEqual(r.counts, { created: 2, skipped: 1, failed: 2 });
  assert.match(r.results[2].reason, /500/);
  assert.match(r.results[3].reason, /not a valid/);
  // Same records as the form path: fides-agreement issues plus KVS records.
  const agreements = await (await import('../src/lib/store.js')).listAgreements();
  assert.ok(agreements.find((a) => a.vendor === 'Juniper Print Co' && a.endDate === '2028-01-31' && a.noticeDays === 45));
  // Re-running the same paste creates nothing new.
  const again = await svc.importAgreements(site.client, text);
  assert.equal(again.counts.created, 0);
  site.state.failCreateFor = null;
  const retry = await svc.importAgreements(site.client, text);
  assert.equal(retry.counts.created, 1, 'only the previously failed row is created on retry');
});

test('import: slices let the board stay inside resolver time limits', async () => {
  const site = fakeSite();
  const lines = ['vendor,end date,notice days', ...Array.from({ length: 25 }, (_, i) => `Batch Vendor ${i},2027-01-01,30`)];
  const text = lines.join('\n');
  let created = 0;
  for (let from = 0; from < 25; from += 10) created += (await svc.importAgreements(site.client, text, { from, to: from + 10 })).counts.created;
  assert.equal(created, 25);
});
