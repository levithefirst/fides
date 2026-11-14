// Pure date and status rules. Shared by the board, the issue panel, the
// scheduled scan, judge-mode seeding and every Rovo action, so the
// Due / Upcoming / On track definition lives in exactly one place.
//
// All dates are calendar dates (YYYY-MM-DD) handled in UTC so that the
// server's timezone never shifts a notice-by date by a day.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const STATUS = Object.freeze({
  DUE: 'DUE', // internal RED
  UPCOMING: 'UPCOMING', // internal AMBER
  ON_TRACK: 'ON_TRACK', // internal GREEN
});

export const STATUS_LABEL = Object.freeze({
  DUE: 'Due',
  UPCOMING: 'Upcoming',
  ON_TRACK: 'On track',
});

// Unique shape per status so status is never encoded by colour alone.
export const STATUS_SHAPE = Object.freeze({
  DUE: '◆', // filled diamond
  UPCOMING: '◧', // half-filled square
  ON_TRACK: '○', // empty ring
});

export const RED_WINDOW_DAYS = 14;
export const AMBER_WINDOW_DAYS = 60;
export const DEFAULT_LOOKAHEAD_DAYS = 60;
export const WINDOWS = Object.freeze([30, 60, 90]);

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDate(value) {
  if (value instanceof Date) {
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }
  if (typeof value !== 'string') return null;
  const m = ISO_DATE.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo, d);
  const check = new Date(ms);
  // Reject impossible dates such as 2026-02-30.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo || check.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

export function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function todayIso(now = new Date()) {
  return formatDate(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function addDays(iso, days) {
  const ms = parseDate(iso);
  if (ms === null) throw new Error(`Invalid date: ${iso}`);
  return formatDate(ms + days * MS_PER_DAY);
}

// Notice-by = end date minus notice period in days. Day arithmetic in UTC
// handles month ends and leap years (2028-03-01 minus 1 day = 2028-02-29).
export function noticeByDate(endDate, noticeDays) {
  const n = Number(noticeDays);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid notice period: ${noticeDays}`);
  return addDays(endDate, -n);
}

export function daysBetween(fromIso, toIso) {
  const a = parseDate(fromIso);
  const b = parseDate(toIso);
  if (a === null || b === null) throw new Error(`Invalid date range: ${fromIso} .. ${toIso}`);
  return Math.round((b - a) / MS_PER_DAY);
}

// Status from days left until a date. Negative means already past.
export function statusForDaysLeft(daysLeft) {
  if (daysLeft <= RED_WINDOW_DAYS) return STATUS.DUE;
  if (daysLeft <= AMBER_WINDOW_DAYS) return STATUS.UPCOMING;
  return STATUS.ON_TRACK;
}

export function isRedWindow(dateIso, today) {
  if (!dateIso) return false;
  return daysBetween(today, dateIso) <= RED_WINDOW_DAYS;
}

// The smallest of the 30 / 60 / 90 day windows that contains the date,
// or null when it is further out (or already past, which is shown as Due).
export function windowFor(daysLeft) {
  if (daysLeft < 0) return 'past';
  for (const w of WINDOWS) if (daysLeft <= w) return w;
  return null;
}

// Full computed view of one agreement. Never throws: a broken record is
// returned with `invalid` so the board can show a recoverable state.
export function evaluate(agreement, today) {
  try {
    const noticeBy = noticeByDate(agreement.endDate, agreement.noticeDays);
    const daysLeft = daysBetween(today, noticeBy);
    const status = statusForDaysLeft(daysLeft);
    return {
      ...agreement,
      noticeBy,
      daysLeft,
      status,
      statusLabel: STATUS_LABEL[status],
      statusShape: STATUS_SHAPE[status],
      window: windowFor(daysLeft),
      invalid: false,
    };
  } catch (e) {
    return { ...agreement, invalid: true, error: e.message };
  }
}

// Same rule the board uses: everything Due plus anything whose notice-by
// falls inside the lookahead.
export function upcomingNotices(agreements, today, lookaheadDays = DEFAULT_LOOKAHEAD_DAYS) {
  return agreements
    .map((a) => evaluate(a, today))
    .filter((a) => !a.invalid && (a.status === STATUS.DUE || a.daysLeft <= lookaheadDays))
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "DD MMM", for example "21 Nov".
export function shortDate(iso) {
  const ms = parseDate(iso);
  if (ms === null) return iso;
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`;
}
