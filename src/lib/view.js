// Pure board view model. board.jsx renders whatever this returns, and the
// tests in test/view.test.mjs pin every clean-site state, so the board is
// never a silent spinner or a blank page.

import { shortDate } from './dates.js';

export const WHY_LINE = "A date reminder can't see that this blocker is still open.";
export const ROVO_NOTE =
  'Rovo Chat is needed for the Fides agent. The board, review issues and escalations work without it.';
export const CONFLUENCE_NOTE =
  'No Confluence contract pages are linked yet. Use "Link a page" on an agreement, or connect Fides to Confluence.';

const SAMPLE_TOTAL = 4;

// "Updated 4m ago, refreshing" for a board painted from the cached snapshot.
export function freshnessText(savedAt, now = Date.now()) {
  const t = Date.parse(savedAt);
  if (!Number.isFinite(t)) return 'Refreshing';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  const age = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : mins < 48 * 60 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
  return `Updated ${age}, refreshing`;
}

// data:      board payload from the getBoard / bootstrap resolver (may be null)
// seeding:   true while this board's own seed call is in flight
// rovo:      true | false | null (null = not known yet)
export function deriveBoardView(data, { seeding = false, rovo = null, now = Date.now() } = {}) {
  if (!data) {
    return { mode: 'loading', banner: { appearance: 'information', title: 'Loading the notice board', text: 'Reading agreements from Jira.' } };
  }
  const agreements = data.agreements || [];
  const seedState = data.seed?.state;
  const view = {
    freshness: data.fromSnapshot ? freshnessText(data.savedAt, now) : null,
    mode: 'ready',
    banner: null,
    showPicker: false,
    showEmpty: false,
    spotlight: spotlightFor(agreements, data.escalations || []),
    rovoNote: rovo === false ? ROVO_NOTE : null,
    rovoEnabled: rovo !== false,
    confluenceNote: agreements.length && agreements.every((a) => !a.confluenceUrl) ? CONFLUENCE_NOTE : null,
  };

  if (data.loadError) {
    return { ...view, mode: 'error', banner: { appearance: 'error', title: 'The board could not load', text: data.loadError } };
  }

  const inProgress = seeding || seedState === 'running';
  if (inProgress) {
    const n = agreements.filter((a) => a.sample).length;
    const esc = (data.escalations || []).length;
    view.mode = 'seeding';
    view.banner = {
      appearance: 'information',
      title: 'Seeding sample agreements...',
      text: `${Math.min(n, SAMPLE_TOTAL)} of ${SAMPLE_TOTAL} sample agreements created${esc ? ', escalation created' : n ? ', escalation pending' : ''}. Rows appear as soon as they exist.`,
      spinner: true,
    };
    return view;
  }

  switch (seedState) {
    case 'no-permission':
      if (!agreements.length) {
        return {
          ...view,
          mode: 'no-permission',
          banner: {
            appearance: 'error',
            title: 'Fides cannot create issues for you',
            text:
              data.seed.message ||
              'You do not have permission to create issues in a Jira project on this site. Ask a Jira admin for the Create issues permission in one project, then reload this page.',
          },
        };
      }
      break;
    case 'no-projects':
      if (!agreements.length) {
        return {
          ...view,
          mode: 'no-projects',
          banner: {
            appearance: 'warning',
            title: 'No Jira project available',
            text: 'There is no Jira project you can use on this site yet. Create a project (any template), then reload this page.',
          },
        };
      }
      break;
    case 'needs-project':
      // Only here: projects exist but none could be picked automatically.
      if (!agreements.length) return { ...view, mode: 'needs-project', showPicker: true };
      break;
    case 'error':
    case 'partial':
      if (!agreements.length) {
        return {
          ...view,
          mode: 'error',
          banner: { appearance: 'error', title: 'Sample agreements could not be created', text: (data.seed.errors || [])[0] || 'Reload the page to retry.' },
          showEmpty: true,
        };
      }
      view.banner = { appearance: 'warning', title: 'Some sample data could not be created', text: (data.seed.errors || [])[0] || 'Reload the page to retry.' };
      break;
    default:
      break;
  }
  if (!agreements.length) {
    view.mode = 'empty';
    view.showEmpty = true;
  }
  return view;
}

// The most urgent Due agreement, with its computed notice-by, open blocker
// and its single linked escalation: the first screen's answer to "why not
// just a date field".
export function spotlightFor(agreements, escalations = []) {
  const due = agreements.filter((a) => !a.invalid && a.status === 'DUE');
  if (!due.length) return null;
  const withBlocker = due.find((a) => (a.openBlockers || []).length) || due[0];
  const a = withBlocker;
  const esc =
    (a.escalations || [])[0] || escalations.find((e) => String(e.agreementId) === String(a.issueId)) || null;
  const blocker = (a.openBlockers || [])[0] || null;
  return {
    issueId: a.issueId,
    issueKey: a.issueKey,
    vendor: a.vendor,
    noticeBy: a.noticeBy,
    noticeByShort: shortDate(a.noticeBy),
    daysLeft: a.daysLeft,
    formula: `Notice by ${a.noticeBy} = end date ${a.endDate} minus ${a.noticeDays} days notice`,
    timing: a.daysLeft < 0 ? `${-a.daysLeft} days ago` : a.daysLeft === 0 ? 'today' : `in ${a.daysLeft} days`,
    blocker,
    escalation: esc ? { issueKey: esc.issueKey, url: esc.url || null, notify: esc.notify || null } : null,
    why: blocker ? WHY_LINE : null,
    askPrompt: `Is ${shortName(a.vendor)} at risk, and what should I do?`,
  };
}

const shortName = (vendor) => String(vendor || '').split(' ')[0] || vendor;
