import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanReviewTitle, reviewResultLine, escalationResultLine } from '../src/lib/resultLines.js';

test('cleanReviewTitle drops a leading Review: and a trailing status word', () => {
  assert.equal(
    cleanReviewTitle('Review: Larkspur Facilities notice by 13 Dec (renew, cancel or renegotiate)'),
    'Larkspur Facilities notice by 13 Dec (renew, cancel or renegotiate)'
  );
  assert.equal(
    cleanReviewTitle('Review: Larkspur Facilities notice by 13 Dec (renew, cancel or renegotiate) Open'),
    'Larkspur Facilities notice by 13 Dec (renew, cancel or renegotiate)'
  );
  assert.equal(cleanReviewTitle(''), '');
});

test('reviewResultLine labels the agreement and the review, reused or created', () => {
  assert.equal(
    reviewResultLine({ issueKey: 'CLSD-37', vendor: 'Larkspur Facilities', reviewKey: 'CLSD-45', created: false }),
    'Agreement: CLSD-37 Larkspur Facilities. Review: CLSD-45 (reused, no duplicate created).'
  );
  assert.equal(
    reviewResultLine({
      issueKey: 'CLSD-37',
      vendor: 'Larkspur Facilities',
      reviewKey: 'CLSD-45',
      created: false,
      reviewTitle: 'Review: Larkspur Facilities notice by 13 Dec (renew, cancel or renegotiate)',
    }),
    'Agreement: CLSD-37 Larkspur Facilities. Review: CLSD-45 (reused, no duplicate created). Larkspur Facilities notice by 13 Dec (renew, cancel or renegotiate).'
  );
  assert.doesNotMatch(
    reviewResultLine({
      issueKey: 'CLSD-37',
      vendor: 'Larkspur Facilities',
      reviewKey: 'CLSD-45',
      created: false,
      reviewTitle: 'Review: Larkspur Facilities notice by 13 Dec (renew, cancel or renegotiate) Open',
    }),
    /Review: Larkspur| Open\.?$/
  );
  assert.equal(
    reviewResultLine({ issueKey: 'CLSD-36', vendor: 'Northwind Analytics', reviewKey: 'CLSD-46', created: true }),
    'Agreement: CLSD-36 Northwind Analytics. Review: CLSD-46 (created).'
  );
});

test('escalationResultLine labels the agreement and the escalation', () => {
  assert.equal(
    escalationResultLine([{ issueKey: 'CLSD-35', vendor: 'Helios Payroll', escalationKey: 'CLSD-40', created: false }]),
    'Agreement: CLSD-35 Helios Payroll. Escalation: CLSD-40 (reused, no duplicate created).'
  );
  assert.equal(
    escalationResultLine([{ issueKey: 'CLSD-35', vendor: 'Helios Payroll', escalationKey: 'CLSD-40', created: true }]),
    'Agreement: CLSD-35 Helios Payroll. Escalation: CLSD-40 (created).'
  );
  assert.equal(escalationResultLine([]), 'No escalation issue was created or reused.');
});
