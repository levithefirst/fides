import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  noticeByDate, daysBetween, statusForDaysLeft, evaluate, upcomingNotices,
  isRedWindow, windowFor, addDays, parseDate, shortDate, STATUS,
} from '../src/lib/dates.js';

const TODAY = '2026-11-14';
const at = (n) => addDays(TODAY, n);
// agreement whose notice-by is `n` days from TODAY
const ag = (n, extra = {}) => ({ issueId: String(n), vendor: `V${n}`, endDate: addDays(at(n), 30), noticeDays: 30, ...extra });

test('notice-by is end date minus notice period', () => {
  assert.equal(noticeByDate('2027-01-31', 30), '2027-01-01');
  assert.equal(noticeByDate('2027-01-31', 0), '2027-01-31');
});

test('month-end and leap-year subtraction', () => {
  assert.equal(noticeByDate('2028-03-01', 1), '2028-02-29'); // leap year
  assert.equal(noticeByDate('2027-03-01', 1), '2027-02-28'); // non-leap
  assert.equal(noticeByDate('2028-03-31', 31), '2028-02-29');
  assert.equal(noticeByDate('2027-01-01', 1), '2026-12-31'); // year boundary
  assert.equal(noticeByDate('2100-03-01', 1), '2100-02-28'); // century, not leap
});

test('rejects invalid input', () => {
  assert.equal(parseDate('2026-02-30'), null);
  assert.equal(parseDate('14/11/2026'), null);
  assert.throws(() => noticeByDate('2026-02-30', 10));
  assert.throws(() => noticeByDate('2026-03-01', -1));
  assert.throws(() => noticeByDate('2026-03-01', 1.5));
  assert.equal(evaluate({ endDate: 'nope', noticeDays: 3 }, TODAY).invalid, true);
});

test('status boundaries: today, past, 14/15, 60/61', () => {
  assert.equal(statusForDaysLeft(0), STATUS.DUE); // today
  assert.equal(statusForDaysLeft(-5), STATUS.DUE); // already past
  assert.equal(statusForDaysLeft(14), STATUS.DUE);
  assert.equal(statusForDaysLeft(15), STATUS.UPCOMING);
  assert.equal(statusForDaysLeft(60), STATUS.UPCOMING);
  assert.equal(statusForDaysLeft(61), STATUS.ON_TRACK);
});

test('evaluate uses the same rule end to end', () => {
  assert.equal(evaluate(ag(0), TODAY).status, STATUS.DUE);
  assert.equal(evaluate(ag(-1), TODAY).status, STATUS.DUE);
  assert.equal(evaluate(ag(14), TODAY).status, STATUS.DUE);
  assert.equal(evaluate(ag(15), TODAY).status, STATUS.UPCOMING);
  assert.equal(evaluate(ag(60), TODAY).status, STATUS.UPCOMING);
  assert.equal(evaluate(ag(61), TODAY).statusLabel, 'On track');
});

test('RED window boundary', () => {
  assert.equal(isRedWindow(at(0), TODAY), true);
  assert.equal(isRedWindow(at(-3), TODAY), true);
  assert.equal(isRedWindow(at(14), TODAY), true);
  assert.equal(isRedWindow(at(15), TODAY), false);
  assert.equal(isRedWindow(null, TODAY), false);
});

test('30/60/90 windows', () => {
  assert.equal(windowFor(-1), 'past');
  assert.equal(windowFor(30), 30);
  assert.equal(windowFor(31), 60);
  assert.equal(windowFor(90), 90);
  assert.equal(windowFor(91), null);
});

test('upcomingNotices honours lookahead and sorts by urgency', () => {
  const list = upcomingNotices([ag(61), ag(3), ag(-2), ag(60), ag(200)], TODAY);
  assert.deepEqual(list.map((a) => a.daysLeft), [-2, 3, 60]);
  assert.equal(upcomingNotices([ag(80)], TODAY, 90).length, 1);
});

test('helpers', () => {
  assert.equal(daysBetween('2026-11-14', '2026-11-20'), 6);
  assert.equal(shortDate('2026-11-05'), '05 Nov');
});
