// Clean-install fixes (fides-clean, Nov 25): inline upcoming list and no
// placeholder domains in the agent prompt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { upcomingInline, ROVO_HINT } from '../src/lib/view.js';

test('inline upcoming list: Due and within 60 days, most urgent first', () => {
  const rows = upcomingInline([
    { issueKey: 'A-1', vendor: 'Quay', status: 'ON_TRACK', daysLeft: 200, noticeBy: '2027-06-01' },
    { issueKey: 'A-2', vendor: 'Larkspur', status: 'UPCOMING', daysLeft: 40, noticeBy: '2027-01-04' },
    { issueKey: 'A-3', vendor: 'Helios', status: 'DUE', daysLeft: 6, noticeBy: '2026-12-01' },
    { issueKey: 'A-4', vendor: 'Bad', invalid: true, status: 'DUE', daysLeft: 1 },
  ]);
  assert.deepEqual(rows.map((r) => r.issueKey), ['A-3', 'A-2']);
  assert.equal(rows[0].timing, 'in 6 days');
  assert.match(ROVO_HINT, /home\.atlassian\.com/);
});

test('agent prompt never carries a placeholder domain and forbids guessed links', () => {
  const p = readFileSync(new URL('../static/agent/prompt.txt', import.meta.url), 'utf8');
  assert.ok(!/https?:\/\/your-domain/i.test(p));
  assert.match(p, /Never write a placeholder or guessed domain/);
});
