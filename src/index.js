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
import { matchAgreement, confirmation } from './lib/match.js';

const friendly = (e) => {
  if (e instanceof jira.ApiError && e.noCreate) return 'You do not have permission to create issues in that Jira project.';
  if (e instanceof jira.ApiError && e.permissionDenied) return 'You do not have permission for that in Jira or Confluence.';
  return e?.message || 'Something went wrong.';
};

// ---------- UI resolvers ----------

const resolver = new Resolver();

// First open of the board: seed judge-mode data if this is a fresh site,
// then return the board. Never throws to the UI.
resolver.define('bootstrap', async ({ context }) => {
  console.log(`Fides board open: product=${installProduct({}, context)}`);
  const client = api.asUser();
  let seed = null;
  try {
    seed = await svc.judgeModeSeed(client, 'board-open');
  } catch (e) {
    seed = { state: 'error', errors: [friendly(e)] };
  }
  // Link sample agreements to their Confluence pages if Confluence became
  // reachable after seeding. No API calls when everything is linked.
  const backfill = await svc.backfillSamplePages(client, { source: 'board-open (jira)' }).catch((e) => {
    console.warn(`Fides board-open backfill failed: ${e.message}`);
    return { errors: [friendly(e)] };
  });
  const board = await safeBoard(client, context?.accountId);
  return { ...board, seedResult: seed, backfill: { linked: backfill.linked?.length || 0, errors: backfill.errors?.slice(0, 3) || [] } };
});

// Never a blank board: any failure comes back as a message the UI shows.
export async function safeBoard(client, accountId = null) {
  try {
    return await svc.boardData(client, { asUser: true, accountId });
  } catch (e) {
    const perm = e instanceof jira.ApiError && e.permissionDenied;
    return {
      loadError: perm ? 'You do not have permission to read the Fides agreement issues in Jira.' : 'Fides could not load the board.',
      loadErrorKind: perm ? 'permission' : 'error',
      loadErrorDetail: perm ? null : friendly(e),
      agreements: [],
      escalations: [],
      counts: { due: 0, upcoming: 0, onTrack: 0 },
      seed: await store.get(store.keys.seed).catch(() => null),
      disclaimer: DISCLAIMER,
    };
  }
}

resolver.define('getBoard', async ({ context }) => safeBoard(api.asUser(), context?.accountId));

// Cheap KVS read: the last board this user saw, painted before anything else.
resolver.define('getSnapshot', async ({ context }) => svc.getSnapshot(context?.accountId));

resolver.define('backfill', async ({ context }) => {
  console.log(`Fides board backfill: product=${installProduct({}, context)}`);
  const r = await svc.backfillSamplePages(api.asUser(), { source: 'board (jira)' }).catch((e) => {
    console.warn(`Fides board backfill failed: ${e.message}`);
    return { linked: [], synced: [] };
  });
  return { linked: r.linked?.length || 0, synced: r.synced?.length || 0 };
});

resolver.define('logPaint', async ({ payload }) => svc.recordPaint(payload || {}));

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

resolver.define('previewImport', async ({ payload }) => {
  try {
    return await svc.previewImport(api.asUser(), payload?.text || '');
  } catch (e) {
    return { ok: false, error: friendly(e), rows: [] };
  }
});

// The board sends the paste in slices (10 rows per call) so each call
// stays well inside the resolver time limit.
resolver.define('runImport', async ({ payload }) => {
  try {
    return await svc.importAgreements(api.asUser(), payload?.text || '', { from: payload?.from || 0, to: payload?.to || 10 });
  } catch (e) {
    return { ok: false, error: friendly(e), results: [] };
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

// Which product this installed event is for. Forge passes the install
// context as an ARI: ari:cloud:jira::site/<id> or ari:cloud:confluence::site/<id>.
export function installProduct(event, context) {
  const ari = String(context?.installContext || event?.context?.installContext || event?.installContext || '');
  if (/^ari:cloud:confluence:/i.test(ari)) return 'confluence';
  if (/^ari:cloud:jira/i.test(ari)) return 'jira';
  return 'unknown';
}

export async function installed(event, context) {
  const retryCount = event?.retryContext?.retryCount || 0;
  const client = api.asApp();
  const product = installProduct(event, context);
  try {
    const seed = await store.get(store.keys.seed);
    // Only the Jira install seeds. A Confluence install (which has its own
    // app storage) never creates Jira samples; it only links pages. Even
    // if the product is unknown, seeding adopts existing Jira samples
    // instead of creating a second set.
    if (product !== 'confluence' && seed?.state !== 'done' && seed?.state !== 'skipped') {
      // Readiness probe: until permissions propagate the app sees no projects.
      const projects = await jira.listProjects(client).catch((e) => {
        if (e instanceof jira.ApiError && e.forbidden) return [];
        throw e;
      });
      if (!projects.length) return retryLater(retryCount, 'app permissions not ready');
      const r = await svc.judgeModeSeed(client, `install (${product})`);
      console.log(`Fides judge mode on install (${product}): ${r.state}${r.adopted ? `, reused ${r.adopted} existing sample agreement(s)` : ''}`);
      if (['needs-project', 'no-projects', 'no-permission', 'partial', 'error'].includes(r.state)) return retryLater(retryCount, `seed ${r.state}`);
    }
    const bf = await svc.backfillSamplePages(client, { source: `install (${product})` });
    console.log(`Fides install (${product}): backfill linked=${bf.linked.length} pagesSynced=${bf.synced.length}`);
    if (bf.forbidden) return retryLater(retryCount, 'Confluence permissions not ready');
  } catch (e) {
    if (e instanceof jira.ApiError && e.forbidden) return retryLater(retryCount, 'permission error');
    console.error(`Fides install seed failed: ${e.message}`);
  }
  return undefined;
}

// ---------- scheduledTrigger (interval: day) ----------

export async function dailyScan(event, context) {
  // Scheduled triggers have no user: api.asApp(). Errors are caught and
  // stamped in KVS (lastRun), never thrown, because Forge does not retry.
  // The trigger fires once per product install. The scan (reviews, pings,
  // escalations) runs in the Jira install only, so nothing is pinged twice;
  // the Confluence install only keeps sample pages and links in step.
  const product = installProduct(event, context);
  console.log(`Fides daily trigger: product=${product}`);
  if (product === 'confluence') {
    const bf = await svc.backfillSamplePages(api.asApp(), { source: 'daily (confluence)' }).catch((e) => {
      console.warn(`Fides daily (confluence) failed: ${e.message}`);
      return { linked: [], synced: [] };
    });
    console.log(`Fides daily (confluence): linked=${bf.linked?.length || 0} pagesSynced=${bf.synced?.length || 0}`);
    return;
  }
  try {
    const stamp = await svc.runScan(api.asApp(), 'scheduledTrigger');
    console.log(`Fides scan ok=${stamp.ok} reviews=${stamp.reviewsCreated} escalations=${stamp.escalationsCreated}`);
    // The product could not be identified (or this is the Jira install):
    // also try the page sync once, so the logs show what this install can do.
    if (product === 'unknown') await svc.backfillSamplePages(api.asApp(), { source: 'daily (product unknown)' }).catch(() => {});
  } catch (e) {
    console.error(`Fides scan failed: ${e.message}`);
  }
}

// ---------- Rovo agent actions (as the current user) ----------

const ctxIssueKey = (payload) => payload?.context?.jira?.issueKey;

// Resolve the agreement an action was asked about: name first (exact, then
// fuzzy), issue key only as a fallback, the page context only when no input
// was given. Every reply carries `resolved` so the agent confirms the key.
function resolveForAction(agreements, payload) {
  const ref = payload?.agreement;
  const m = matchAgreement(agreements, ref, ctxIssueKey(payload));
  if (m.agreement) {
    return {
      a: m.agreement,
      resolved: {
        issueKey: m.agreement.issueKey,
        vendor: m.agreement.vendor,
        matchedBy: m.matchedBy,
        confirmation: confirmation(ref, m),
      },
    };
  }
  if (m.candidates.length) {
    return {
      error: `"${ref}" matches more than one agreement. Ask the user which one they mean.`,
      candidates: m.candidates.map((x) => `${x.issueKey} ${x.vendor}`),
    };
  }
  return {
    error: `I could not find an agreement matching "${ref ?? ''}" among the ones you can see. Ask me to list upcoming notices first.`,
    known: agreements.map((x) => `${x.issueKey} ${x.vendor}`),
  };
}

export async function listUpcomingNotices(payload) {
  try {
    const client = api.asUser();
    const days = Number.isFinite(Number(payload?.days)) && Number(payload.days) > 0 ? Number(payload.days) : DEFAULT_LOOKAHEAD_DAYS;
    const today = todayIso();
    // Jira-backed: the same answer from the Jira and the Confluence install.
    const [agreements, escalations] = await Promise.all([svc.visibleAgreements(client, { asUser: true }), svc.loadEscalations(client)]);
    const escByAgreement = new Map();
    for (const v of escalations) {
      if (!v?.issueKey) continue;
      const id = String(v.agreementId);
      escByAgreement.set(id, [...(escByAgreement.get(id) || []), { issueKey: v.issueKey, blockerKey: v.blockerKey, dateAtRisk: v.dateAtRisk || null }]);
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
    const { a, resolved, ...miss } = resolveForAction(agreements, payload);
    if (!a) return { ...miss, disclaimer: DISCLAIMER };
    const r = await svc.ensureReviewIssue(client, a, { reason: 'requested in Rovo Chat' });
    return {
      resolved,
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
    let resolved = null;
    if (payload?.agreement || ctxIssueKey(payload)) {
      const res = resolveForAction(agreements, payload);
      if (!res.a) {
        const { a: _none, resolved: _r, ...miss } = res;
        return { ...miss, disclaimer: DISCLAIMER };
      }
      scope = [res.a];
      resolved = res.resolved;
    }
    const r = await svc.escalateAll(client, scope);
    return {
      ...(resolved ? { resolved } : {}),
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

// Rovo action: check-agreement-from-page (GET). Read-only: is this page
// already tracked, or what would be proposed? Writes nothing, so Rovo runs
// it without a confirmation card.
export async function checkAgreementFromPageAction(payload) {
  try {
    console.log('Fides check-agreement-from-page');
    const r = await svc.trackAgreementFromPage(api.asUser(), {
      pageRef: payload?.page,
      contextContentId: payload?.context?.confluence?.contentId || null,
      confirm: false,
    });
    return { ...r, readOnly: true, disclaimer: DISCLAIMER };
  } catch (e) {
    return { status: 'error', error: friendly(e), disclaimer: DISCLAIMER };
  }
}

// Rovo action: track-agreement-from-page (CREATE). Writes only when the
// user has confirmed (confirm: true); with confirm false it is read-only.
// Idempotent per Confluence page.
export async function trackAgreementFromPageAction(payload) {
  try {
    const client = api.asUser();
    const overrides = {};
    if (payload?.vendor) overrides.vendor = String(payload.vendor);
    if (payload?.endDate) overrides.endDate = String(payload.endDate);
    if (payload?.noticeDays !== undefined && payload?.noticeDays !== null && payload?.noticeDays !== '') overrides.noticeDays = Number(payload.noticeDays);
    if (payload?.owner) overrides.owner = String(payload.owner);
    const r = await svc.trackAgreementFromPage(client, {
      pageRef: payload?.page,
      contextContentId: payload?.context?.confluence?.contentId || null,
      confirm: payload?.confirm === true || payload?.confirm === 'true',
      overrides,
    });
    return { ...r, disclaimer: DISCLAIMER };
  } catch (e) {
    return { status: 'error', error: friendly(e), disclaimer: DISCLAIMER };
  }
}

// The line the agent must include in every brief, verbatim.
export function sourceLine(src) {
  switch (src.status) {
    case 'read':
      return `Source: ${src.title || 'Confluence contract page'} (${src.url || 'link unavailable'})`;
    case 'forbidden':
      return 'Source: the linked Confluence contract page could not be read because you do not have permission to view it. This brief uses only the dates and obligations stored in Fides.';
    case 'not-found':
      return 'Source: the linked Confluence contract page could not be read because it no longer exists or was moved. This brief uses only the dates and obligations stored in Fides.';
    case 'error':
      return 'Source: the linked Confluence contract page could not be read (Confluence returned an error). This brief uses only the dates and obligations stored in Fides.';
    case 'skipped':
      return 'Source: the Confluence contract page was not read, as requested. This brief uses only the dates and obligations stored in Fides.';
    default:
      return 'Source: no Confluence contract page is linked to this agreement. This brief uses only the dates and obligations stored in Fides.';
  }
}

export async function draftBriefAction(payload) {
  try {
    const client = api.asUser();
    const agreements = await svc.visibleAgreements(client, { asUser: true });
    // A Confluence page id or URL is also accepted as the input.
    const pageRef = jira.parsePageRef(payload?.agreement) || payload?.context?.confluence?.contentId;
    const byPage = pageRef ? agreements.find((x) => String(x.confluencePageId) === String(pageRef)) : null;
    const res = byPage
      ? { a: byPage, resolved: { issueKey: byPage.issueKey, vendor: byPage.vendor, matchedBy: 'Confluence page', confirmation: `Resolved the Confluence page ${pageRef} to ${byPage.issueKey} ${byPage.vendor} (matched by Confluence page).` } }
      : resolveForAction(agreements, payload);
    const { a, resolved } = res;
    if (!a) {
      const { a: _none, resolved: _r, ...miss } = res;
      return { ok: false, ...miss, disclaimer: DISCLAIMER };
    }

    // Read the linked contract page as the user, and record exactly what was
    // (or was not) read so the brief can cite its source.
    let pageText = null;
    let pageStatus = a.confluencePageId ? 'none' : 'not-linked';
    let source = { status: pageStatus, title: null, url: a.confluenceUrl || null };
    if (a.confluencePageId && payload?.readPage === false) {
      source = { status: 'skipped', title: null, url: a.confluenceUrl || null };
    } else if (a.confluencePageId) {
      try {
        const page = await jira.getPage(client, a.confluencePageId);
        pageText = storageToText(page.storage);
        pageStatus = 'read';
        const url = page.base && page.webui ? `${page.base}${page.webui}` : a.confluenceUrl || null;
        source = { status: 'read', title: page.title || null, url, pageId: String(a.confluencePageId) };
      } catch (e) {
        pageStatus = e.forbidden ? 'forbidden' : e.notFound ? 'not-found' : 'error';
        source = { status: pageStatus, title: null, url: a.confluenceUrl || null, pageId: String(a.confluencePageId) };
      }
    }
    const blockers = await svc.findBlockers(client, a).catch(() => []);
    const brief = draftBrief({ agreement: a, today: todayIso(), pageText, pageStatus: pageStatus === 'not-found' ? 'forbidden' : pageStatus, blockers });
    brief.resolved = resolved;
    brief.source = source;
    brief.sourceLine = sourceLine(source);
    if (brief.ok !== false) {
      brief.escalations = (await svc.loadEscalations(client).catch(() => []))
        .filter((v) => String(v.agreementId) === String(a.issueId) && v.issueKey)
        .map((v) => ({ issueKey: v.issueKey, blockerKey: v.blockerKey, dateAtRisk: v.dateAtRisk || null }));
    }
    if (brief.contractPage) brief.contractPage.message = brief.sourceLine;
    return brief;
  } catch (e) {
    return { ok: false, error: friendly(e), disclaimer: DISCLAIMER };
  }
}
