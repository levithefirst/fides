// Gap 5: agreement matching resolves by name first, never by a nearby key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAgreement, confirmation, isAllAgreementsRef } from '../src/lib/match.js';

const A = [
  { issueId: '10007', issueKey: 'CLSD-7', vendor: 'Helios Payroll', summary: 'Helios Payroll agreement (sample): notice by 2026-11-21' },
  { issueId: '10008', issueKey: 'CLSD-8', vendor: 'Larkspur Facilities' },
  { issueId: '10009', issueKey: 'CLSD-9', vendor: 'Northwind Analytics' },
  { issueId: '10010', issueKey: 'CLSD-10', vendor: 'Quay Support' },
];
const key = (ref, ctx) => matchAgreement(A, ref, ctx).agreement?.issueKey ?? null;

test('the live bug: Northwind never resolves to Helios, even on the Helios issue page', () => {
  assert.equal(key('Northwind Analytics', 'CLSD-7'), 'CLSD-9');
  assert.equal(key('Northwind Analytics'), 'CLSD-9');
});

test('exact, contained and fuzzy names', () => {
  assert.equal(matchAgreement(A, 'northwind analytics').matchedBy, 'exact name');
  assert.equal(key('Northwind'), 'CLSD-9');
  assert.equal(key('the Northwind Analytics agreement'), 'CLSD-9');
  assert.equal(key('Nortwind Analytics'), 'CLSD-9'); // typo
  assert.equal(matchAgreement(A, 'Nortwind Analytics').matchedBy, 'similar name');
  assert.equal(key('helios'), 'CLSD-7');
  assert.equal(key('Quay'), 'CLSD-10');
});

test('name beats a key in the same input; key is only a fallback', () => {
  assert.equal(key('Northwind Analytics (CLSD-7)'), 'CLSD-9');
  assert.equal(key('CLSD-8'), 'CLSD-8');
  assert.equal(matchAgreement(A, 'CLSD-8').matchedBy, 'issue key');
  assert.equal(key('10010'), 'CLSD-10');
});

test('context issue only when no input was given', () => {
  assert.equal(key('', 'CLSD-8'), 'CLSD-8');
  assert.equal(key(undefined, 'CLSD-8'), 'CLSD-8');
  assert.equal(key('Northwind', 'CLSD-8'), 'CLSD-9');
});

test('ambiguous or unknown names are never guessed', () => {
  const two = [...A, { issueId: '10011', issueKey: 'CLSD-11', vendor: 'Northwind Logistics' }];
  const m = matchAgreement(two, 'Northwind');
  assert.equal(m.agreement, null);
  assert.equal(m.candidates.length, 2);
  assert.equal(matchAgreement(two, 'Northwind Logistics').agreement.issueKey, 'CLSD-11');
  assert.equal(key('Acme Widgets'), null);
  assert.equal(key('CLSD-99'), null);
});

test('confirmation line names the resolved key', () => {
  const m = matchAgreement(A, 'Northwind Analytics', 'CLSD-7');
  assert.equal(confirmation('Northwind Analytics', m), 'Resolved "Northwind Analytics" to CLSD-9 Northwind Analytics (matched by exact name).');
});


test('isAllAgreementsRef treats empty, all, and all agreements the same', () => {
  for (const v of [undefined, null, '', '  ', 'all', 'ALL', 'all agreements', 'All Agreements']) {
    assert.equal(isAllAgreementsRef(v), true, String(v));
  }
  assert.equal(isAllAgreementsRef('Helios Payroll'), false);
  assert.equal(isAllAgreementsRef('all vendors'), false);
});
