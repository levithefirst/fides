import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../src/lib/dates.js';
import {
  isBlockerOpen, planEscalations, escalationKey, dateAtRisk, riskSentence, escalationLabel,
} from '../src/lib/escalation.js';

const TODAY = '2026-11-14';
const agreement = (noticeIn, extra = {}) => ({
  issueId: '10001', issueKey: 'OPS-1', vendor: 'Helios Payroll',
  endDate: addDays(addDays(TODAY, noticeIn), 30), noticeDays: 30, ...extra,
});
const open = { id: '20001', key: 'OPS-2', summary: 'Approval pending', statusCategory: 'new' };
const inProgress = { id: '20002', key: 'OPS-3', summary: 'Question', statusCategory: 'indeterminate' };
const closed = { id: '20003', key: 'OPS-4', summary: 'Done', statusCategory: 'done' };

test('open / closed blocker check', () => {
  assert.equal(isBlockerOpen(open), true);
  assert.equal(isBlockerOpen(inProgress), true);
  assert.equal(isBlockerOpen(closed), false);
  assert.equal(isBlockerOpen({ fields: { status: { statusCategory: { key: 'done' } } } }), false);
  assert.equal(isBlockerOpen({}), true); // unknown counts as open
});

test('RED window boundary drives escalation (14/15, today, past)', () => {
  assert.equal(planEscalations(agreement(14), [open], TODAY).length, 1);
  assert.equal(planEscalations(agreement(15), [open], TODAY).length, 0);
  assert.equal(planEscalations(agreement(0), [open], TODAY).length, 1);
  assert.equal(planEscalations(agreement(-4), [open], TODAY).length, 1);
});

test('closed blockers never escalate', () => {
  assert.equal(planEscalations(agreement(3), [closed], TODAY).length, 0);
  assert.equal(planEscalations(agreement(3), [closed, open, inProgress], TODAY).length, 2);
});

test('idempotency: an already-claimed pair is skipped', () => {
  const a = agreement(3);
  const first = planEscalations(a, [open], TODAY);
  assert.equal(first.length, 1);
  const claimed = new Set(first.map((p) => p.key));
  assert.equal(planEscalations(a, [open], TODAY, claimed).length, 0);
  // a second blocker on the same agreement is a different pair
  assert.equal(planEscalations(a, [open, inProgress], TODAY, claimed).length, 1);
  assert.equal(escalationKey('1', '2'), 'esc:1:2');
  assert.equal(escalationLabel('1', '2'), 'fides-esc-1-2');
});

test('milestone date can be the date at risk', () => {
  const a = agreement(40, { milestoneDate: addDays(TODAY, 5) });
  const risk = dateAtRisk(a, TODAY);
  assert.deepEqual(risk, { kind: 'milestone', date: addDays(TODAY, 5) });
  assert.match(riskSentence(risk), /may put the milestone date of 19 Nov at risk/);
});

test('hedged wording for notice risk', () => {
  const risk = dateAtRisk(agreement(6), TODAY);
  assert.equal(risk.kind, 'notice');
  assert.equal(riskSentence(risk), 'This open blocker may put the notice date of 20 Nov at risk.');
});
