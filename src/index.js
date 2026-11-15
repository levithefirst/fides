// Forge function handlers referenced from manifest.yml.
//
//   resolver           UI Kit board, project page and issue panel (asUser)
//   installed          avi:forge:installed:app trigger: judge-mode seed (asApp)
//   dailyScan          scheduledTrigger interval: day (asApp)
//   list/create/escalate/brief   Rovo agent actions (asUser)

import api from '@forge/api';
import Resolver from '@forge/resolver';
import { InvocationError, InvocationErrorCode } from '@forge/events';
import * as svc from './services.js';
import * as store from './lib/store.js';
import * as jira from './lib/atlassian.js';
import { todayIso, evaluate, upcomingNotices, DEFAULT_LOOKAHEAD_DAYS, shortDate } from './lib/dates.js';
import { draftBrief, storageToText, DISCLAIMER } from './lib/brief.js';

const friendly = (e) => {
  if (e instanceof jira.ApiError && e.noCreate) return 'You do not have permission to create issues in that Jira project.';
  if (e instanceof jira.ApiError && e.permissionDenied) return 'You do not have permission for that in Jira or Confluence.';
  return e?.message || 'Something went wrong.';
};

// ---------- UI resolvers ----------

const resolver = new Resolver();

// First open of the board: seed judge-mode data if this is a fresh site,
// then return the board. Never throws to the UI.
resolver.define('bootstrap', async () => {
  const client = api.asUser();
  let seed = null;
  try {
    seed = await svc.judgeModeSeed(client, 'board-open');
  } catch (e) {
    seed = { state: 'error', errors: [friendly(e)] };
  }
  // Link sample agreements to their Confluence pages if Confluence became
  // reachable after seeding. No API calls when everything is linked.
  const backfill = await svc.backfillSamplePages(client).catch((e) => ({ errors: [friendly(e)] }));
  const board = await safeBoard(client);
  return { ...board, seedResult: seed, backfill: { linked: backfill.linked?.length || 0, errors: backfill.errors?.slice(0, 3) || [] } };
});

// Never a blank board: any failure comes back as a message the UI shows.
export async function safeBoard(client) {
  try {
    return await svc.boardData(client, { asUser: true });
  } catch (e) {
    const perm = e instanceof jira.ApiError && e.permissionDenied;
    return {
      loadError: perm ? 'You do not have permission to read the Fides agreement issues in Jira. Ask a Jira admin for Browse projects permission.' : `Fides could not load the board: ${friendly(e)}`,
      agreements: [],
      escalations: [],
      counts: { due: 0, upcoming: 0, onTrack: 0 },
      seed: await store.get(store.keys.seed).catch(() => null),
      disclaimer: DISCLAIMER,
    };
  }
}

resolver.define('getBoard', async () => safeBoard(api.asUser()));

resolver.define('listProjects', async () => {
  try {
    return { ok: true, projects: await jira.listProjects(api.asUser()) };
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
});

resolver.define('setProject', async ({ payload }) => {
  try {
    const cfg = await svc.ensureConfig(api.asUser(), payload.projectKey);
    return { ok: true, config: cfg };
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
});

resolver.define('loadSamples', async () => {
  const client = api.asUser();
  // Explicit request from the board. Still idempotent: existing samples
  // are reused, never duplicated.
  try {
    const r = await svc.judgeModeSeed(client, 'load-samples', { force: true });
    return { ok: true, seed: r };
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
});

resolver.define('createAgreement', async ({ payload }) => {
  try {
    const a = await svc.createAgreement(api.asUser(), payload);
    return { ok: true, agreement: a };
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
});

resolver.define('runScanNow', async () => {
  const stamp = await svc.runScan(api.asUser(), 'manual (board)');
  return { ok: stamp.ok, lastRun: stamp };
});

resolver.define('createReview', async ({ payload }) => {
  try {
    const client = api.asUser();
    const agreements = await svc.visibleAgreements(client, { asUser: true });
    const a = svc.resolveAgreement(agreements, payload.issueId);
    if (!a) return { ok: false, error: 'Agreement not found or not visible to you.' };
    return { ok: true, ...(await svc.ensureReviewIssue(client, a, { reason: 'requested from the board' })) };
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
});

resolver.define('linkPage', async ({ payload }) => {
  try {
    const client = api.asUser();
    const pageId = jira.parsePageRef(payload.pageRef);
    if (!pageId) return { ok: false, error: 'Paste a Confluence page URL or page id.' };
    const page = await jira.getPage(client, pageId);
    const a = await store.get(store.keys.agreement(payload.issueId));
    if (!a) return { ok: false, error: 'Agreement not found.' };
    const url = page.base && page.webui ? `${page.base}${page.webui}` : String(payload.pageRef);
    await store.saveAgreement({ ...a, confluencePageId: pageId, confluenceUrl: url });
    await jira.addRemoteLink(client, a.issueKey, url, `Contract page: ${a.vendor}`).catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.forbidden || e.notFound ? 'You cannot read that Confluence page, or it does not exist.' : friendly(e) };
  }
});

// Issue panel: show status for an agreement, review, blocker or escalation.
resolver.define('getPanel', async ({ context }) => {
  const client = api.asUser();
  const issueId = String(context?.extension?.issue?.id || '');
  const issueKey = context?.extension?.issue?.key;
  const today = todayIso();
  const base = await svc.siteBase(client).catch(() => '');
  const direct = issueId ? await store.get(store.keys.agreement(issueId)) : null;
  if (direct) return { kind: 'agreement', agreement: evaluate(direct, today), baseUrl: base, disclaimer: DISCLAIMER };
  // Otherwise find a tracked agreement linked to this issue.
  try {
    const issue = await jira.getIssue(client, issueKey || issueId);
    for (const l of issue.links) {
      const a = l.id ? await store.get(store.keys.agreement(l.id)) : null;
      if (a) {
        const kind = issue.labels.includes('fides-escalation')
          ? 'escalation'
          : issue.labels.includes('fides-blocker')
            ? 'blocker'
            : issue.labels.includes('fides-review')
              ? 'review'
              : 'linked';
        return { kind, agreement: evaluate(a, today), baseUrl: base, disclaimer: DISCLAIMER };
      }
    }
  } catch {
    // fall through to "not tracked"
  }
  return { kind: 'none', disclaimer: DISCLAIMER };
});

export const handler = resolver.getDefinitions();

// ---------- install trigger: judge mode on install ----------

// Best effort. Board open is the guaranteed seeding path; this only gets
// there first when the app user's permissions are already in place. On a
// new install they lag (observed ~45 s), so we check readiness first,
// without taking the seed lock, and retry with back-off. The same event
// fires when Fides is connected to Confluence, which is when the page
// backfill links existing sample agreements to their contract pages.
const INSTALL_BACKOFF_S = [10, 30, 90, 270]; // Forge retries up to 4 times

function retryLater(retryCount, why) {
  if (retryCount >= INSTALL_BACKOFF_S.length) {
    console.log(`Fides install: giving up after ${retryCount} retries (${why}); board open will seed.`);
    return undefined;
  }
  const retryAfter = INSTALL_BACKOFF_S[retryCount];
  console.log(`Fides install: ${why}; retry ${retryCount + 1} in ${retryAfter}s`);
  return new InvocationError({ retryAfter, retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST });
}

export async function installed(event) {
  const retryCount = event?.retryContext?.retryCount || 0;
  const client = api.asApp();
  try {
    const seed = await store.get(store.keys.seed);
    if (seed?.state !== 'done' && seed?.state !== 'skipped') {
      // Readiness probe: until permissions propagate the app sees no projects.
      const projects = await jira.listProjects(client).catch((e) => {
        if (e instanceof jira.ApiError && e.forbidden) return [];
        throw e;
      });
      if (!projects.length) return retryLater(retryCount, 'app permissions not ready');
      const r = await svc.judgeModeSeed(client, 'install');
      console.log(`Fides judge mode on install: ${r.state}`);
      if (['needs-project', 'no-projects', 'no-permission', 'partial', 'error'].includes(r.state)) return retryLater(retryCount, `seed ${r.state}`);
    }
    const bf = await svc.backfillSamplePages(client);
    if (bf.linked.length) console.log(`Fides install: linked ${bf.linked.length} sample agreement(s) to Confluence pages`);
    if (bf.forbidden) return retryLater(retryCount, 'Confluence permissions not ready');
  } catch (e) {
    if (e instanceof jira.ApiError && e.forbidden) return retryLater(retryCount, 'permission error');
    console.error(`Fides install seed failed: ${e.message}`);
  }
  return undefined;
}

// ---------- scheduledTrigger (interval: day) ----------

export async function dailyScan() {
  // Scheduled triggers have no user: api.asApp(). Errors are caught and
  // stamped in KVS (lastRun), never thrown, because Forge does not retry.
  try {
    const stamp = await svc.runScan(api.asApp(), 'scheduledTrigger');
    console.log(`Fides scan ok=${stamp.ok} reviews=${stamp.reviewsCreated} escalations=${stamp.escalationsCreated}`);
  } catch (e) {
    console.error(`Fides scan failed: ${e.message}`);
  }
}

// ---------- Rovo agent actions (as the current user) ----------

const ctxIssueKey = (payload) => payload?.context?.jira?.issueKey;

export async function listUpcomingNotices(payload) {
  try {
    const client = api.asUser();
    const days = Number.isFinite(Number(payload?.days)) && Number(payload.days) > 0 ? Number(payload.days) : DEFAULT_LOOKAHEAD_DAYS;
    const today = todayIso();
    const agreements = await svc.visibleAgreements(client, { asUser: true });
    const escKeys = await store.listEscalationKeys();
    const escByAgreement = new Map();
    for (const k of escKeys) {
      const v = await store.get(k);
      if (!v?.issueKey) continue;
      const id = String(v.agreementId);
      escByAgreement.set(id, [...(escByAgreement.get(id) || []), { issueKey: v.issueKey, blockerKey: v.blockerKey, dateAtRisk: v.dateAtRisk }]);
    }
    const notices = upcomingNotices(agreements, today, days);
    // Open blockers for Due agreements, read as the user, so the agent can
    // see what a date reminder cannot: the decision is stuck on open work.
    const blockersById = new Map();
    await Promise.all(
      notices
        .filter((a) => a.status === 'DUE')
        .slice(0, 10)
        .map(async (a) => {
          const b = await svc.findBlockers(client, a).catch(() => []);
          blockersById.set(String(a.issueId), b.filter((x) => x.statusCategory !== 'done').map((x) => ({ key: x.key, summary: x.summary, status: x.statusName })));
        })
    );
    const list = notices.map((a) => ({
      issueKey: a.issueKey,
      vendor: a.vendor,
      status: a.statusLabel,
      noticeBy: a.noticeBy,
      noticeByShort: shortDate(a.noticeBy),
      daysLeft: a.daysLeft,
      endDate: a.endDate,
      owner: a.owner,
      spend: a.spend,
      contractPage: a.confluenceUrl || null,
      escalated: escByAgreement.has(String(a.issueId)),
      escalations: escByAgreement.get(String(a.issueId)) || [],
      openBlockers: blockersById.get(String(a.issueId)) || [],
      noticeByRule: `${a.endDate} minus ${a.noticeDays} days notice = ${a.noticeBy}`,
    }));
    return {
      today,
      lookaheadDays: days,
      rule: 'Due = notice-by within 14 days or past; Upcoming = 15 to 60 days; On track = more than 60 days.',
      count: list.length,
      agreements: list,
      disclaimer: DISCLAIMER,
    };
  } catch (e) {
    return { error: friendly(e), disclaimer: DISCLAIMER };
  }
}

export async function createReviewIssueAction(payload) {
  try {
    const client = api.asUser();
    const agreements = await svc.visibleAgreements(client, { asUser: true });
    const a = svc.resolveAgreement(agreements, payload?.agreement, ctxIssueKey(payload));
    if (!a) {
      return {
        error: 'I could not find that agreement among the ones you can see. Ask me to list upcoming notices first.',
        known: agreements.map((x) => `${x.issueKey} ${x.vendor}`),
      };
    }
    const r = await svc.ensureReviewIssue(client, a, { reason: 'requested in Rovo Chat' });
    return {
      created: r.created,
      reviewIssue: r.issueKey,
      url: r.url,
      agreement: `${a.issueKey} ${a.vendor}`,
      note: r.created ? 'Review issue created and linked to the agreement.' : 'An open review issue already exists; no duplicate was created.',
      disclaimer: DISCLAIMER,
    };
  } catch (e) {
    return { error: friendly(e), disclaimer: DISCLAIMER };
  }
}

export async function escalateThreatenedMilestones(payload) {
  try {
    const client = api.asUser();
    const agreements = await svc.visibleAgreements(client, { asUser: true });
    let scope = agreements;
    if (payload?.agreement || ctxIssueKey(payload)) {
      const a = svc.resolveAgreement(agreements, payload?.agreement, ctxIssueKey(payload));
      if (!a) return { error: 'Agreement not found among the ones you can see.' };
      scope = [a];
    }
    const r = await svc.escalateAll(client, scope);
    return {
      rule: 'An escalation is created once per agreement and blocker when the blocker is still open and the notice-by or milestone date is within 14 days or past.',
      created: r.created,
      alreadyEscalated: r.existing,
      errors: r.errors,
      summary: r.created.length
        ? `${r.created.length} escalation issue(s) created.`
        : r.existing.length
          ? 'Threatened milestones were already escalated; no duplicates created.'
          : 'No open blockers threaten a date in the next 14 days.',
      disclaimer: DISCLAIMER,
    };
  } catch (e) {
    return { error: friendly(e), disclaimer: DISCLAIMER };
  }
}

export async function draftBriefAction(payload) {
  try {
    const client = api.asUser();
    const agreements = await svc.visibleAgreements(client, { asUser: true });
    let a = svc.resolveAgreement(agreements, payload?.agreement, ctxIssueKey(payload));
    // Allow a Confluence page id or URL as the input.
    const pageRef = jira.parsePageRef(payload?.agreement) || payload?.context?.confluence?.contentId;
    if (!a && pageRef) a = agreements.find((x) => String(x.confluencePageId) === String(pageRef)) || null;
    if (!a) return { error: 'Agreement not found among the ones you can see.', disclaimer: DISCLAIMER };

    let pageText = null;
    let pageStatus = a.confluencePageId ? 'none' : 'not-linked';
    if (a.confluencePageId && payload?.readPage !== false) {
      try {
        const page = await jira.getPage(client, a.confluencePageId);
        pageText = storageToText(page.storage);
        pageStatus = 'read';
      } catch (e) {
        pageStatus = e.forbidden || e.notFound ? 'forbidden' : 'error';
      }
    }
    const blockers = await svc.findBlockers(client, a).catch(() => []);
    const brief = draftBrief({ agreement: a, today: todayIso(), pageText, pageStatus, blockers });
    if (brief.ok !== false) {
      brief.escalations = [];
      for (const k of await store.listEscalationKeys()) {
        if (!k.startsWith(`esc:${a.issueId}:`)) continue;
        const v = await store.get(k);
        if (v?.issueKey) brief.escalations.push({ issueKey: v.issueKey, blockerKey: v.blockerKey, dateAtRisk: v.dateAtRisk });
      }
    }
    if (pageStatus === 'forbidden') {
      brief.contractPage.message = 'You do not have permission to read the linked Confluence page, so this brief uses only the stored dates and obligations.';
    } else if (pageStatus === 'not-linked') {
      brief.contractPage.message = 'No Confluence contract page is linked yet. Link one from the Fides board for a fuller brief.';
    }
    return brief;
  } catch (e) {
    return { ok: false, error: friendly(e), disclaimer: DISCLAIMER };
  }
}
