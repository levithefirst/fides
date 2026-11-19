// Pure drafting for the renew / cancel / renegotiate brief. The Rovo agent
// receives this structured draft from the `draft-brief` action and turns it
// into prose. Every brief is hedged and carries the not-legal-advice line.

import { evaluate, shortDate, STATUS } from './dates.js';
import { isBlockerOpen } from './escalation.js';

export const DISCLAIMER = 'Fides tracks dates and obligations; it is not legal advice.';

const KEYWORDS = /(renew|notice|terminat|cancel|uplift|increase|penalt|credit|liabilit|auto-?renew|sla|true-?up)/i;

// Convert Confluence storage-format HTML to plain text (no parser, no upload).
export function storageToText(storage) {
  if (!storage) return '';
  return String(storage)
    .replace(/<\/(p|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[hd]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// Assistive read of the already-linked page: pull the sentences that mention
// renewal, notice, termination, price or penalties. Capped and quoted, so the
// agent can cite them rather than invent terms.
export function relevantExcerpts(text, max = 5) {
  if (!text) return [];
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12 && s.length < 400);
  const seen = new Set();
  const out = [];
  for (const s of sentences) {
    if (KEYWORDS.test(s) && !seen.has(s)) {
      seen.add(s);
      out.push(s);
      if (out.length >= max) break;
    }
  }
  return out;
}

export function draftBrief({ agreement, today, pageText = null, pageStatus = 'none', blockers = [] }) {
  const a = evaluate(agreement, today);
  if (a.invalid) {
    return { ok: false, error: `Agreement dates are incomplete (${a.error}).`, disclaimer: DISCLAIMER };
  }
  const openBlockers = blockers.filter(isBlockerOpen);
  const excerpts = relevantExcerpts(pageText);
  const when =
    a.daysLeft < 0
      ? `The notice-by date (${shortDate(a.noticeBy)}) appears to have passed ${-a.daysLeft} day(s) ago.`
      : `The notice-by date is ${shortDate(a.noticeBy)}, ${a.daysLeft} day(s) from today.`;

  const options = [
    {
      option: 'Renew',
      considerations: [
        'Confirm the renewal term and any price uplift with the vendor in writing.',
        'Check the stored obligations are still being met before committing.',
      ],
    },
    {
      option: 'Cancel',
      considerations: [
        `Written notice may need to reach the vendor by ${shortDate(a.noticeBy)}; check the notice clause for the required method.`,
        'Plan the exit: data export, access removal, replacement service.',
      ],
    },
    {
      option: 'Renegotiate',
      considerations: [
        'Use the notice window as leverage while there is still time to give notice.',
        'List the terms to change (price, term length, service credits) before the call.',
      ],
    },
  ];

  const ifMissed = [
    'If the notice date passes without notice, the agreement may renew automatically on its current terms.',
    'A missed notice could mean another full term of spend before the next exit point.',
    'Unmet obligations could lead to disputes or service credits; check the contract wording.',
  ];

  return {
    ok: true,
    vendor: a.vendor,
    issueKey: a.issueKey,
    status: a.statusLabel,
    endDate: a.endDate,
    noticeBy: a.noticeBy,
    daysLeft: a.daysLeft,
    spend: a.spend,
    owner: a.owner,
    obligations: a.obligations,
    timing: when,
    urgent: a.status === STATUS.DUE,
    openBlockers: openBlockers.map((b) => ({ key: b.key, summary: b.summary })),
    blockerNote: openBlockers.length
      ? `${openBlockers.length} open blocker(s) may delay a decision before the notice date.`
      : 'No open blockers are linked.',
    options,
    whatAMissCouldMean: ifMissed,
    contractPage: {
      status: pageStatus, // 'read' | 'forbidden' | 'not-found' | 'not-linked' | 'error' | 'none' | 'skipped'
      excerpts,
    },
    hedging:
      'Present these as options to discuss, not as a recommendation to cancel or renew. Quote the contract excerpts rather than paraphrasing terms you cannot see.',
    disclaimer: DISCLAIMER,
  };
}
