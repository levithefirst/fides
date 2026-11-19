// Pure board view model. board.jsx renders whatever this returns, and the
// tests in test/view.test.mjs pin every clean-site state, so the board is
// never a silent spinner or a blank page.

import { shortDate } from './dates.js';

export const WHY_LINE = "A date reminder can't see that this blocker is still open.";
// Every non-ready state is one plain sentence plus one next step.
export const state = (appearance, sentence, nextStep, extra = {}) => ({ appearance, title: sentence, sentence, nextStep, text: `Next step: ${nextStep}`, ...extra });

export const ROVO_NOTE =
  'Rovo Chat is not available on this site. Next step: ask a site admin to turn on Rovo; the board, scan and escalations keep working without it.';
export const CONFLUENCE_NOTE =
  'Fides cannot read Confluence contract pages here yet. Next step: connect Fides to Confluence, or use "Link a page" on an agreement.';

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
    return { mode: 'loading', canCreate: true, banner: state('information', 'Loading the notice board.', 'Wait a moment; agreements are being read from Jira.') };
  }
  const agreements = data.agreements || [];
  const seedState = data.seed?.state;
  const perms = data.permissions || null; // { canCreate, isAdmin, projectKey } or null when unknown
  const project = perms?.projectKey || data.config?.projectKey || 'the Fides project';
  const view = {
    freshness: data.fromSnapshot ? freshnessText(data.savedAt, now) : null,
    mode: 'ready',
    banner: null,
    showPicker: false,
    showEmpty: false,
    canCreate: perms?.canCreate !== false,
    isAdmin: perms?.isAdmin === true,
    spotlight: spotlightFor(agreements, data.escalations || []),
    rovoNote: rovo === false ? ROVO_NOTE : null,
    rovoEnabled: rovo !== false,
    confluenceNote: agreements.length && agreements.every((a) => !a.confluenceUrl) ? CONFLUENCE_NOTE : null,
  };

  if (data.loadError) {
    const next =
      data.loadErrorKind === 'permission'
        ? 'Ask a Jira admin for Browse projects permission on the Fides project, then reload.'
        : 'Reload the page to retry.';
    return { ...view, mode: 'error', canCreate: false, banner: state('error', data.loadError, next, { detail: data.loadErrorDetail || null }) };
  }

  // JQL silently returns nothing for a user without Browse projects: say
  // so instead of showing "No agreements are tracked yet".
  if (perms && perms.canBrowse === false) {
    return {
      ...view,
      mode: 'error',
      canCreate: false,
      banner: state('error', 'You do not have permission to read the Fides agreement issues in Jira.', `Ask a Jira admin for Browse projects permission on ${project}, then reload.`),
    };
  }

  const inProgress = seeding || seedState === 'running';
  if (inProgress) {
    const n = agreements.filter((a) => a.sample).length;
    const esc = (data.escalations || []).length;
    view.mode = 'seeding';
    view.banner = {
      ...state(
        'information',
        'Seeding sample agreements...',
        'Wait a few seconds; rows appear as soon as they exist.'
      ),
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
          canCreate: false,
          banner: state('error', 'Fides cannot create issues for you on this site.', 'Ask a Jira admin for the Create issues permission in one project, then reload this page.', { title: 'Fides cannot create issues for you', detail: data.seed.message || null }),
        };
      }
      break;
    case 'no-projects':
      if (!agreements.length) {
        return {
          ...view,
          mode: 'no-projects',
          banner: state('warning', 'There is no Jira project you can use on this site yet.', 'Create a project (any template), then reload this page.'),
        };
      }
      break;
    case 'needs-project':
      // Only here: projects exist but none could be picked automatically.
      if (!agreements.length) {
        if (perms && !perms.isAdmin) {
          return { ...view, mode: 'needs-project', banner: state('information', 'Fides needs a Jira project to keep agreements in.', 'Ask a Jira admin to open Apps > Fides and pick the project.') };
        }
        return { ...view, mode: 'needs-project', showPicker: true, banner: state('information', 'Fides needs a Jira project to keep agreements in.', 'Pick the project below.') };
      }
      break;
    case 'error':
    case 'partial':
      if (!agreements.length) {
        return {
          ...view,
          mode: 'error',
          showEmpty: true,
          banner: state('error', 'Sample agreements could not be created.', 'Reload the page to retry, or add an agreement yourself.', { detail: (data.seed.errors || [])[0] || null }),
        };
      }
      view.banner = state('warning', 'Some sample data could not be created.', 'Reload the page to retry.', { detail: (data.seed.errors || [])[0] || null });
      break;
    default:
      break;
  }

  // Signed in without Create issues in the chosen project: read-only board.
  if (perms && perms.canCreate === false) {
    view.canCreate = false;
    view.mode = agreements.length ? 'read-only' : 'no-permission';
    view.banner = state('warning', `You can view agreements but cannot create issues in ${project}.`, `Ask a Jira admin for the Create issues permission in ${project}.`);
    return view;
  }

  if (!agreements.length) {
    view.mode = 'empty';
    view.showEmpty = true;
    view.banner = state('information', 'No agreements are tracked yet.', 'Load the samples, import rows from a spreadsheet, or add your first agreement.');
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


// Board actions cell: link an open review when one exists, otherwise the
// create button on Due agreements only.
export function reviewAction(a) {
  if (a?.openReview?.issueKey) return { type: 'link', issueKey: a.openReview.issueKey, url: a.openReview.url || null };
  if (a?.status === 'DUE') return { type: 'create' };
  return { type: 'none' };
}
