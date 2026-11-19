import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewResultLine, escalationResultLine } from '../src/lib/resultLines.js';

test('reviewResultLine labels the agreement and the review, reused or created', () => {
  assert.equal(
    reviewResultLine({ issueKey: 'CLSD-37', vendor: 'Larkspur Facilities', reviewKey: 'CLSD-45', created: false }),
    'Agreement: CLSD-37 Larkspur Facilities. Review: CLSD-45 (reused, no duplicate created).'
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
