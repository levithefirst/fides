import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSamples } from '../src/lib/samples.js';
import { evaluate, STATUS } from '../src/lib/dates.js';
import { planEscalations } from '../src/lib/escalation.js';
import { draftBrief, relevantExcerpts, storageToText, DISCLAIMER } from '../src/lib/brief.js';

const TODAY = '2026-02-20';

test('seeder yields Due, Upcoming and On track relative to today', () => {
  const s = buildSamples(TODAY);
  const statuses = s.map((x) => evaluate(x, TODAY).status);
  assert.ok(statuses.includes(STATUS.DUE));
  assert.ok(statuses.includes(STATUS.UPCOMING));
  assert.ok(statuses.includes(STATUS.ON_TRACK));
  assert.equal(new Set(s.map((x) => x.sampleKey)).size, s.length);
});

test('exactly one RED sample carries a blocker and would escalate', () => {
  const s = buildSamples(TODAY);
  const withBlocker = s.filter((x) => x.blocker);
  assert.equal(withBlocker.length, 1);
  const red = { ...withBlocker[0], issueId: '1' };
  assert.equal(evaluate(red, TODAY).status, STATUS.DUE);
  assert.equal(planEscalations(red, [{ id: '2', key: 'X-2', statusCategory: 'new' }], TODAY).length, 1);
  assert.doesNotMatch(JSON.stringify(s), /\bRFI\b/i);
});

test('brief is hedged and cites page excerpts', () => {
  const [helios] = buildSamples(TODAY);
  const text = storageToText('<p>This agreement renews automatically unless notice is given.</p><p>Lunch is at noon.</p>');
  assert.deepEqual(relevantExcerpts(text), ['This agreement renews automatically unless notice is given.']);
  const b = draftBrief({ agreement: helios, today: TODAY, pageText: text, pageStatus: 'read' });
  assert.equal(b.ok, true);
  assert.equal(b.disclaimer, DISCLAIMER);
  assert.equal(b.urgent, true);
  assert.ok(b.whatAMissCouldMean.every((l) => /\bmay\b|\bcould\b/.test(l)));
  assert.doesNotMatch(JSON.stringify(b), /you must cancel/i);
});

test('brief reports incomplete dates instead of throwing', () => {
  const b = draftBrief({ agreement: { vendor: 'X', endDate: '', noticeDays: 1 }, today: TODAY });
  assert.equal(b.ok, false);
});
