// Pure rules for threatened-milestone escalation.
//
// A blocker is a Jira issue labelled `fides-blocker` and linked to an
// agreement issue: an open question, a pending approval, or an unmet
// deliverable. If a blocker is still open while the agreement's notice-by
// (or optional milestone) date is in the RED window, Fides creates exactly
// one escalation issue for that agreement + blocker pair.

import { isRedWindow, noticeByDate, shortDate, daysBetween } from './dates.js';

export const LABELS = Object.freeze({
  AGREEMENT: 'fides-agreement',
  REVIEW: 'fides-review',
  BLOCKER: 'fides-blocker',
  ESCALATION: 'fides-escalation',
  SAMPLE: 'fides-sample',
});

// Jira status categories: 'new' (To Do), 'indeterminate' (In Progress),
// 'done' (Done). Anything not 'done' counts as open. A missing category is
// treated as open so a blocker is never silently dropped.
export function isBlockerOpen(blocker) {
  const key = blocker?.statusCategory ?? blocker?.fields?.status?.statusCategory?.key;
  return key !== 'done';
}

export function escalationKey(agreementId, blockerId) {
  return `esc:${agreementId}:${blockerId}`;
}

// Jira label used as a second, Jira-side idempotency guard (labels may not
// contain spaces; issue ids are numeric).
export function escalationLabel(agreementId, blockerId) {
  return `fides-esc-${agreementId}-${blockerId}`;
}

// Which date is at risk: the earliest of notice-by and milestone that is in
// the RED window. Returns null when neither is.
export function dateAtRisk(agreement, today) {
  const candidates = [];
  try {
    candidates.push({ kind: 'notice', date: noticeByDate(agreement.endDate, agreement.noticeDays) });
  } catch {
    // invalid agreement dates: no notice candidate
  }
  if (agreement.milestoneDate) {
    candidates.push({ kind: 'milestone', date: agreement.milestoneDate });
  }
  const red = candidates.filter((c) => {
    try {
      return isRedWindow(c.date, today);
    } catch {
      return false;
    }
  });
  if (!red.length) return null;
  red.sort((a, b) => daysBetween(b.date, a.date));
  return red[0];
}

// Decide which escalations to create for one agreement.
// `existing` is a Set of escalation keys already claimed.
export function planEscalations(agreement, blockers, today, existing = new Set()) {
  const risk = dateAtRisk(agreement, today);
  if (!risk) return [];
  return blockers
    .filter(isBlockerOpen)
    .filter((b) => !existing.has(escalationKey(agreement.issueId, b.id)))
    .map((b) => ({
      key: escalationKey(agreement.issueId, b.id),
      label: escalationLabel(agreement.issueId, b.id),
      agreement,
      blocker: b,
      risk,
    }));
}

// Hedged wording, never a legal instruction.
export function riskSentence(risk) {
  const what = risk.kind === 'milestone' ? 'milestone date' : 'notice date';
  return `This open blocker may put the ${what} of ${shortDate(risk.date)} at risk.`;
}

export function escalationSummary(agreement, blocker, risk) {
  const what = risk.kind === 'milestone' ? 'milestone' : 'notice date';
  return `Escalation: ${agreement.vendor} ${what} ${shortDate(risk.date)} may be at risk (${blocker.key})`;
}
