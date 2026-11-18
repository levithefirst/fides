// Fides core loop, shared by the UI resolvers, the Rovo actions, the daily
// scheduledTrigger and the install trigger. Each function takes a `client`
// (api.asUser() or api.asApp()) so the same code is permission-aware for
// people and runs without a user for scheduled work.

import * as jira from './lib/atlassian.js';
import { adf, ApiError } from './lib/atlassian.js';
import * as store from './lib/store.js';
import { evaluate, todayIso, shortDate, STATUS, upcomingNotices, DEFAULT_LOOKAHEAD_DAYS } from './lib/dates.js';
import {
  LABELS,
  planEscalations,
  riskSentence,
  escalationSummary,
  isBlockerOpen,
  escalationKey,
} from './lib/escalation.js';
import { buildSamples, samplePageTitle, samplePageBody, SAMPLE_VERSION } from './lib/samples.js';
import { DISCLAIMER } from './lib/brief.js';
import { matchAgreement } from './lib/match.js';
import { extractAgreement } from './lib/extract.js';
import { parseImport, dupKey, MAX_ROWS } from './lib/importRows.js';
import { storageToText } from './lib/brief.js';

const sampleLabel = (k) => `fides-sample-${k}`;

// ---------- site helpers ----------

export async function siteBase(client) {
  const cfg = (await store.get(store.keys.config)) || {};
  if (cfg.baseUrl) return cfg.baseUrl;
  const info = await jira.getServerInfo(client);
  const baseUrl = info?.baseUrl?.replace(/\/$/, '') || '';
  if (baseUrl) await store.set(store.keys.config, { ...cfg, baseUrl });
  return baseUrl;
}

const browse = (base, key) => (base && key ? `${base}/browse/${key}` : null);

// Use the stored project, or discover the first project on this site where a
// standard issue type can be created. Never hardcodes a project key.
export async function ensureConfig(client, preferredProjectKey) {
  return (await resolveConfig(client, preferredProjectKey)).cfg;
}

// Same as ensureConfig, plus why no project could be used:
//   'no-projects'    the caller can see no Jira project at all
//   'no-permission'  projects exist but the caller can create issues in none
//   'needs-project'  auto-pick failed for another reason: offer the picker
export async function resolveConfig(client, preferredProjectKey) {
  const cfg = (await store.get(store.keys.config)) || {};
  if (cfg.projectKey && cfg.issueTypeId && !preferredProjectKey) return { cfg, reason: null };
  const projects = await jira.listProjects(client);
  const ordered = preferredProjectKey ? projects.filter((p) => p.key === preferredProjectKey) : projects;
  if (!ordered.length) return { cfg: null, reason: preferredProjectKey ? 'needs-project' : 'no-projects', projects: 0 };
  let denied = 0;
  for (const p of ordered) {
    try {
      const t = await jira.pickIssueType(client, p.key);
      const next = { ...cfg, projectId: p.id, projectKey: p.key, projectName: p.name, issueTypeId: t.id, issueTypeName: t.name };
      await store.set(store.keys.config, next);
      return { cfg: next, reason: null };
    } catch (e) {
      if (preferredProjectKey) throw e;
      if (e instanceof ApiError && e.permissionDenied) denied += 1;
    }
  }
  return { cfg: null, reason: denied === ordered.length ? 'no-permission' : 'needs-project', projects: ordered.length };
}

export const PERMISSION_MESSAGE =
  'You do not have permission to create issues in a Jira project on this site, so Fides cannot create sample agreements. Ask a Jira admin for the Create issues permission in one project, then reload this page.';

// ---------- owners: resolve once at save, notify through Jira ----------

// Atlassian account ids: 24 alphanumerics (e.g. 5b10a2844c20165700ede21g)
// or the newer "557058:<uuid>" form.
const ACCOUNT_ID = /^(?:\d{6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-z]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const isAccountId = (v) => ACCOUNT_ID.test(String(v || '').trim());
const USER_SEARCH_OFF = 'cap:userSearchUnavailable';

// Turn the owner a person typed (account id, email or name) into a Jira
// accountId, once, when the agreement is saved. Name and email lookup needs
// Jira user search (read:jira-user), which Fides does not request; when the
// site refuses it we remember that for a day and fall back quietly.
export async function resolveOwner(client, { owner, ownerAccountId } = {}) {
  if (ownerAccountId) return { ownerAccountId: String(ownerAccountId), ownerResolution: 'picked' };
  const text = String(owner || '').trim();
  if (!text) return { ownerAccountId: null, ownerResolution: 'none' };
  if (isAccountId(text)) return { ownerAccountId: text, ownerResolution: 'account-id' };
  if (await store.get(USER_SEARCH_OFF)) return { ownerAccountId: null, ownerResolution: 'user-search-unavailable' };
  try {
    const users = (await jira.searchUsers(client, text)).filter((u) => u.active !== false && (u.accountType || 'atlassian') === 'atlassian');
    const t = text.toLowerCase();
    const exact = users.filter((u) => (u.emailAddress || '').toLowerCase() === t || (u.displayName || '').toLowerCase() === t);
    if (exact.length === 1) return { ownerAccountId: exact[0].accountId, ownerResolution: 'matched' };
    if (exact.length > 1 || users.length > 1) return { ownerAccountId: null, ownerResolution: 'ambiguous' };
    if (users.length === 1) return { ownerAccountId: users[0].accountId, ownerResolution: 'matched' };
    return { ownerAccountId: null, ownerResolution: 'not-found' };
  } catch (e) {
    if (e instanceof ApiError && (e.forbidden || e.status === 404)) {
      await store.kvsSetTtl(USER_SEARCH_OFF, { at: new Date().toISOString() }, 24 * 3600).catch(() => {});
      return { ownerAccountId: null, ownerResolution: 'user-search-unavailable' };
    }
    return { ownerAccountId: null, ownerResolution: 'not-found' };
  }
}

// Who a review or escalation issue goes to: the stored owner, else the
// agreement issue's assignee, else nobody.
export async function notifyTarget(client, agreement) {
  if (agreement.ownerAccountId) return { accountId: agreement.ownerAccountId, via: 'owner' };
  try {
    const i = await jira.getIssue(client, agreement.issueKey);
    if (i.assigneeAccountId) return { accountId: i.assigneeAccountId, via: 'agreement-assignee' };
  } catch {
    // fall through to unassigned
  }
  return { accountId: null, via: 'unassigned' };
}

// Create a review or escalation issue assigned to the notify target, then
// add the owner as a watcher. Jira sends its own notifications; Fides sends
// no email. A failed assignment or watcher never blocks the issue.
async function createNotifiedIssue(client, agreement, fields) {
  const target = await notifyTarget(client, agreement);
  const issue = await jira.createIssue(client, { ...fields, assigneeAccountId: target.accountId });
  const warnings = [];
  if (issue.warning) warnings.push(issue.warning);
  let watcher = false;
  if (agreement.ownerAccountId) {
    try {
      await jira.addWatcher(client, issue.key, agreement.ownerAccountId);
      watcher = true;
    } catch (e) {
      warnings.push(`Could not add the owner as a watcher: ${e.message}`);
    }
  }
  for (const w of warnings) console.warn(`Fides ${issue.key}: ${w}`);
  const notify = {
    via: issue.assigned ? target.via : 'unassigned',
    assigneeAccountId: issue.assigned ? target.accountId : null,
    watcher,
    notified: issue.assigned || watcher,
    warnings,
  };
  return { ...issue, notify };
}

// ---------- agreements ----------

function agreementDescription(a) {
  const parts = [
    adf.p(adf.strong('Vendor agreement tracked by Fides. '), ...(a.sample ? [adf.em('Sample data from judge mode.')] : [])),
    adf.p(`End date: ${a.endDate}. Notice period: ${a.noticeDays} days. Spend: ${a.spend || 'n/a'}. Owner: ${a.owner || 'n/a'}.`),
    adf.p(`Key obligations: ${a.obligations || 'n/a'}`),
  ];
  if (a.confluenceUrl) parts.push(adf.p('Contract page: ', adf.link(a.confluenceUrl, a.confluenceUrl)));
  parts.push(adf.p(adf.em(DISCLAIMER)));
  return adf.doc(...parts);
}

export async function createAgreement(client, input, { sample = false, sampleKey = null } = {}) {
  const cfg = await ensureConfig(client);
  if (!cfg) throw new ApiError('No Jira project available. Pick a project on the Fides board.', 400, null);
  const record = {
    vendor: String(input.vendor || '').trim(),
    endDate: input.endDate,
    noticeDays: Number(input.noticeDays),
    milestoneDate: input.milestoneDate || null,
    spend: input.spend || '',
    owner: input.owner || '',
    obligations: input.obligations || '',
    confluencePageId: jira.parsePageRef(input.confluencePageId || input.confluenceUrl) || null,
    confluenceUrl: input.confluenceUrl || null,
    sample,
    sampleKey,
  };
  const ev = evaluate(record, todayIso());
  if (!record.vendor || ev.invalid) throw new ApiError(`Invalid agreement: ${ev.error || 'vendor is required'}`, 400, null);
  const labels = [LABELS.AGREEMENT, ...(sample ? [LABELS.SAMPLE, sampleLabel(sampleKey)] : [])];
  const summary = `${record.vendor} agreement${sample ? ' (sample)' : ''}: notice by ${ev.noticeBy}`;
  record.summary = summary;
  // Sample owners are team names, so judge mode skips the lookup (and keeps
  // the cold start fast); everyone else is resolved once, here.
  Object.assign(record, sample ? { ownerAccountId: null, ownerResolution: 'none' } : await resolveOwner(client, input));
  const issue = await jira.createIssue(client, {
    projectId: cfg.projectId,
    issueTypeId: cfg.issueTypeId,
    summary,
    description: agreementDescription(record),
    labels,
    assigneeAccountId: record.ownerAccountId,
  });
  if (issue.warning) console.warn(`Fides ${issue.key}: ${issue.warning}`);
  const saved = await store.saveAgreement({
    ...record,
    issueId: issue.id,
    issueKey: issue.key,
    projectId: cfg.projectId,
    projectKey: cfg.projectKey,
    createdAt: new Date().toISOString(),
  });
  if (record.confluenceUrl) {
    const link = jira
      .addRemoteLink(client, issue.key, record.confluenceUrl, `Contract page: ${record.vendor}`, record.confluencePageId ? jira.pageGlobalId(record.confluencePageId) : undefined)
      .catch(() => {});
    if (!sample) await link; // judge mode does not wait on it
    else saved.pending = link;
  }
  return saved;
}

// Agreements the caller can see. With a user client this filters by Jira
// browse permission, so the board and Rovo never show issues the user
// cannot open.
export async function visibleAgreements(client, { asUser }) {
  const all = await store.listAgreements();
  if (!asUser || !all.length) return all;
  const ids = all.map((a) => String(a.issueId)).filter(Boolean);
  const visible = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const found = await jira.bulkFetch(client, ids.slice(i, i + 100), ['summary']);
    found.forEach((f) => visible.add(String(f.id)));
  }
  return all.filter((a) => visible.has(String(a.issueId)));
}

// Resolve an agreement reference (vendor name first, then issue key or id;
// see lib/match.js). Kept as a thin wrapper for the UI resolvers.
export function resolveAgreement(agreements, ref, contextIssueKey) {
  return matchAgreement(agreements, ref, contextIssueKey).agreement;
}

// ---------- blockers ----------

export async function findBlockers(client, agreement) {
  const issue = await jira.getIssue(client, agreement.issueKey);
  const linkedKeys = [...new Set(issue.links.map((l) => l.key).filter(Boolean))];
  if (!linkedKeys.length) return [];
  const found = await jira.searchIssues(
    client,
    `key in (${linkedKeys.join(',')}) AND labels = "${LABELS.BLOCKER}"`,
    ['summary', 'status', 'labels'],
    50
  );
  return found.map((b) => ({ id: b.id, key: b.key, summary: b.summary, statusCategory: b.statusCategory, statusName: b.statusName }));
}

// ---------- review issues ----------

export async function ensureReviewIssue(client, agreement, { reason = 'notice window' } = {}) {
  const base = await siteBase(client);
  const existing = await store.get(store.keys.review(agreement.issueId));
  if (existing?.issueKey) {
    try {
      const i = await jira.getIssue(client, existing.issueKey);
      if (i.statusCategory !== 'done') return { created: false, issueKey: i.key, url: browse(base, i.key) };
    } catch (e) {
      if (!e.notFound) throw e;
    }
  }
  const cfg = await ensureConfig(client);
  const ev = evaluate(agreement, todayIso());
  const issue = await createNotifiedIssue(client, agreement, {
    projectId: agreement.projectId || cfg.projectId,
    issueTypeId: cfg.issueTypeId,
    summary: `Review: ${agreement.vendor} notice by ${shortDate(ev.noticeBy)} (renew, cancel or renegotiate)`,
    description: adf.doc(
      adf.p(`The notice window for ${agreement.vendor} is open (${reason}). Notice-by date: ${ev.noticeBy}, ${ev.daysLeft} day(s) from today.`),
      adf.p('Decide whether to renew, cancel or renegotiate. Ask Fides in Rovo Chat to draft a brief from the contract page.'),
      adf.p('Agreement: ', adf.link(agreement.issueKey, browse(base, agreement.issueKey) || agreement.issueKey)),
      ...(agreement.confluenceUrl ? [adf.p('Contract page: ', adf.link(agreement.confluenceUrl, agreement.confluenceUrl))] : []),
      adf.p(adf.em(DISCLAIMER))
    ),
    labels: [LABELS.REVIEW, ...(agreement.sample ? [LABELS.SAMPLE] : [])],
  });
  const types = await jira.linkTypeNames(client);
  await jira.linkIssues(client, types.relates, issue.key, agreement.issueKey).catch(() => {});
  await store.set(store.keys.review(agreement.issueId), { issueKey: issue.key, at: new Date().toISOString(), notify: issue.notify });
  return { created: true, issueKey: issue.key, url: browse(base, issue.key), notify: issue.notify };
}

// ---------- threatened-milestone escalation ----------

// `knownBlockers` / `fresh` let judge mode skip lookups for issues it has
// just created; every other caller discovers blockers from Jira.
export async function escalateAgreement(client, agreement, today, existing, { knownBlockers = null, fresh = false } = {}) {
  const out = { created: [], existing: [], errors: [] };
  if (!agreement.issueKey) return out;
  const ev = evaluate(agreement, today);
  if (ev.invalid) return out;
  const blockers = knownBlockers || (await findBlockers(client, agreement));
  const plans = planEscalations(agreement, blockers, today, existing);
  // Pairs already escalated are reported, not recreated.
  for (const b of blockers.filter(isBlockerOpen)) {
    const k = escalationKey(agreement.issueId, b.id);
    if (existing.has(k)) {
      const v = await store.get(k);
      if (v?.issueKey) out.existing.push({ issueKey: v.issueKey, blockerKey: b.key });
    }
  }
  if (!plans.length) return out;
  const base = await siteBase(client);
  const cfg = await ensureConfig(client);
  const types = await jira.linkTypeNames(client);
  for (const plan of plans) {
    const won = await store.claim(plan.key, { state: 'creating', at: new Date().toISOString() });
    if (!won) continue;
    try {
      // Jira-side guard in case KVS was cleared (skipped for a blocker
      // created moments ago, which cannot have an escalation yet).
      const dup = fresh ? [] : await jira.searchIssues(client, `labels = "${plan.label}"`, ['summary'], 1);
      let issueKey = dup[0]?.key;
      let notify = null;
      if (!issueKey) {
        const { blocker, risk } = plan;
        const issue = await createNotifiedIssue(client, agreement, {
          projectId: agreement.projectId || cfg.projectId,
          issueTypeId: cfg.issueTypeId,
          summary: escalationSummary(agreement, blocker, risk),
          description: adf.doc(
            adf.p(adf.strong(riskSentence(risk))),
            adf.p(`Blocker: `, adf.link(`${blocker.key} ${blocker.summary || ''}`.trim(), browse(base, blocker.key) || blocker.key), ` (status: ${blocker.statusName || 'open'}).`),
            adf.p(`Agreement: `, adf.link(`${agreement.issueKey} ${agreement.vendor}`, browse(base, agreement.issueKey) || agreement.issueKey), `. Notice-by ${ev.noticeBy}, end date ${agreement.endDate}.`),
            ...(agreement.confluenceUrl
              ? [adf.p('Contract page: ', adf.link(agreement.confluenceUrl, agreement.confluenceUrl))]
              : [adf.p('Contract page: not linked yet.')]),
            adf.p('Suggested next step: resolve or re-scope the blocker, or decide on renewal without it, before the date above.'),
            adf.p(adf.em(DISCLAIMER))
          ),
          labels: [LABELS.ESCALATION, plan.label, ...(agreement.sample ? [LABELS.SAMPLE] : [])],
        });
        issueKey = issue.key;
        notify = issue.notify;
        await Promise.all([
          jira.linkIssues(client, types.relates, issueKey, agreement.issueKey).catch(() => {}),
          jira.linkIssues(client, types.relates, issueKey, plan.blocker.key).catch(() => {}),
          agreement.confluenceUrl
            ? jira
                .addRemoteLink(client, issueKey, agreement.confluenceUrl, `Contract page: ${agreement.vendor}`, agreement.confluencePageId ? jira.pageGlobalId(agreement.confluencePageId) : undefined)
                .catch(() => {})
            : null,
        ]);
      }
      await store.set(plan.key, {
        state: 'done',
        issueKey,
        agreementId: agreement.issueId,
        agreementKey: agreement.issueKey,
        vendor: agreement.vendor,
        blockerKey: plan.blocker.key,
        dateAtRisk: plan.risk.date,
        riskKind: plan.risk.kind,
        notify,
        at: new Date().toISOString(),
      });
      existing.add(plan.key);
      out.created.push({ issueKey, url: browse(base, issueKey), blockerKey: plan.blocker.key, sentence: riskSentence(plan.risk), notify });
    } catch (e) {
      // Release the claim so the next run can retry.
      await store.del(plan.key).catch(() => {});
      out.errors.push(`${agreement.issueKey}: ${e.message}`);
    }
  }
  return out;
}

export async function escalateAll(client, agreements, today = todayIso()) {
  const existing = await store.listEscalationKeys();
  const result = { created: [], existing: [], errors: [] };
  // Most urgent first so the RED agreement is handled before anything else.
  const ordered = agreements.map((a) => evaluate(a, today)).filter((a) => !a.invalid && a.status === STATUS.DUE);
  ordered.sort((a, b) => a.daysLeft - b.daysLeft);
  for (const a of ordered) {
    try {
      const r = await escalateAgreement(client, a, today, existing);
      result.created.push(...r.created);
      result.existing.push(...r.existing);
      result.errors.push(...r.errors);
    } catch (e) {
      result.errors.push(`${a.issueKey}: ${e.message}`);
    }
  }
  return result;
}

// ---------- the scan (scheduledTrigger, judge mode, "Run scan now") ----------

export async function runScan(client, source) {
  const startedAt = new Date().toISOString();
  const today = todayIso();
  const stamp = { at: startedAt, source, ok: true, reviewsCreated: 0, pings: 0, escalationsCreated: 0, errors: [] };
  try {
    const bf = await backfillSamplePages(client).catch((e) => ({ errors: [e.message] }));
    stamp.pagesLinked = bf.linked?.length || 0;
    const agreements = await store.listAgreements();
    // Escalations first: they are the time-critical signal.
    const esc = await escalateAll(client, agreements, today);
    stamp.escalationsCreated = esc.created.length;
    stamp.errors.push(...esc.errors);
    for (const a of agreements.map((x) => evaluate(x, today))) {
      if (a.invalid || a.status !== STATUS.DUE || !a.issueKey) continue;
      try {
        const r = await ensureReviewIssue(client, a, { reason: 'daily scan' });
        if (r.created) stamp.reviewsCreated += 1;
        else if (a.daysLeft <= 0) {
          const rev = (await store.get(store.keys.review(a.issueId))) || {};
          if (rev.pingedFor !== a.noticeBy) {
            await jira.addComment(
              client,
              r.issueKey,
              adf.doc(adf.p(`Reminder from Fides: the notice-by date for ${a.vendor} (${a.noticeBy}) has been reached. `), adf.p(adf.em(DISCLAIMER)))
            );
            await store.set(store.keys.review(a.issueId), { ...rev, issueKey: r.issueKey, pingedFor: a.noticeBy });
            stamp.pings += 1;
          }
        }
      } catch (e) {
        stamp.errors.push(`${a.issueKey}: ${e.message}`);
      }
    }
  } catch (e) {
    stamp.errors.push(e.message);
  }
  return saveStamp(stamp);
}

async function saveStamp(stamp) {
  stamp.ok = stamp.errors.length === 0;
  stamp.finishedAt = new Date().toISOString();
  if (stamp.ok) stamp.lastSuccessAt = stamp.finishedAt;
  else {
    const prev = await store.get(store.keys.lastRun).catch(() => null);
    stamp.lastSuccessAt = prev?.lastSuccessAt || null;
  }
  stamp.errors = stamp.errors.slice(0, 10);
  await store.set(store.keys.lastRun, stamp).catch(() => {});
  return stamp;
}

// ---------- judge mode ----------

async function ensureSample(client, s, cfg, space, base) {
  const known = await store.get(store.keys.sample(s.sampleKey));
  if (known?.issueId) {
    const a = await store.get(store.keys.agreement(known.issueId));
    if (a) return a;
  }
  // Jira-side guard in case KVS lost the sample key, run in parallel with
  // the Confluence page lookup to keep first load fast.
  const title = samplePageTitle(s.vendor);
  const [dup, existingPage] = await Promise.all([
    jira.searchIssues(client, `labels = "${sampleLabel(s.sampleKey)}" AND labels = "${LABELS.AGREEMENT}"`, ['summary'], 1).catch(() => []),
    space ? jira.findPageByTitle(client, space.id, title).catch(() => null) : null,
  ]);
  if (dup[0]) {
    const a = await store.get(store.keys.agreement(dup[0].id));
    if (a) {
      await store.set(store.keys.sample(s.sampleKey), { issueId: a.issueId });
      return a;
    }
  }

  let page = existingPage;
  if (space && !page) {
    try {
      page = await jira.createPage(client, { spaceId: space.id, title, storage: samplePageBody(s) });
    } catch {
      page = null; // recoverable: the board shows "link a page"
    }
  }
  const wikiBase = page?.base || (base ? `${base}/wiki` : '');
  const confluenceUrl = page?.webui ? `${wikiBase}${page.webui}` : null;
  if (page?.id) await store.set(store.keys.samplePage(s.sampleKey), { id: page.id, url: confluenceUrl });
  const agreement = await createAgreement(
    client,
    { ...s, confluencePageId: page?.id || null, confluenceUrl },
    { sample: true, sampleKey: s.sampleKey }
  );
  await store.set(store.keys.sample(s.sampleKey), { issueId: agreement.issueId });

  if (s.blocker) {
    const blocker = await jira.createIssue(client, {
      projectId: cfg.projectId,
      issueTypeId: cfg.issueTypeId,
      summary: s.blocker.summary,
      description: adf.doc(adf.p(s.blocker.description), adf.p(adf.em('Sample blocker created by Fides judge mode.'))),
      labels: [LABELS.BLOCKER, LABELS.SAMPLE],
    });
    const types = await jira.linkTypeNames(client);
    await jira.linkIssues(client, types.blocks, blocker.key, agreement.issueKey);
    const { pending, ...record } = agreement;
    const saved = { ...(await store.saveAgreement({ ...record, sampleBlockerKey: blocker.key })), pending };
    saved.newBlocker = { id: blocker.id, key: blocker.key, summary: s.blocker.summary, statusCategory: 'new', statusName: 'To Do' };
    return saved;
  }
  return agreement;
}

// ---------- Confluence link backfill ----------

// Attach a Confluence page to an agreement: remote link on the agreement
// (required) and on its review and escalation issues (best effort), then
// store the page id. Remote links use a stable globalId, so a rerun updates
// rather than duplicates.
async function linkAgreementPage(client, agreement, pageId, url) {
  const title = `Contract page: ${agreement.vendor}`;
  const gid = jira.pageGlobalId(pageId);
  await jira.addRemoteLink(client, agreement.issueKey, url, title, gid);
  const related = [];
  const review = await store.get(store.keys.review(agreement.issueId));
  if (review?.issueKey) related.push(review.issueKey);
  for (const k of await store.listEscalationKeys()) {
    if (!k.startsWith(`esc:${agreement.issueId}:`)) continue;
    const v = await store.get(k);
    if (v?.issueKey) related.push(v.issueKey);
  }
  await Promise.all(related.map((key) => jira.addRemoteLink(client, key, url, title, gid).catch(() => {})));
  const fresh = (await store.get(store.keys.agreement(agreement.issueId))) || agreement;
  await store.saveAgreement({ ...fresh, confluencePageId: pageId, confluenceUrl: url });
}

// Sample agreements seeded before Confluence was reachable (for example the
// Jira install ran before Confluence was connected) have no page. Find each
// sample page by the stored page record or by exact title in any space, and
// create it only if Confluence answered that none exists. Never duplicates
// pages; does nothing (no API calls) when every sample is already linked.
export async function backfillSamplePages(client, { createMissing = true } = {}) {
  const out = { linked: [], created: [], errors: [], forbidden: false };
  const todo = (await store.listAgreements()).filter((a) => a.sample && a.sampleKey && a.issueKey && !a.confluencePageId);
  if (!todo.length) return out;
  const base = await siteBase(client).catch(() => '');
  let spacePromise = null;
  const space = () => (spacePromise ??= jira.pickSpace(client).catch(() => null));
  await Promise.all(
    todo.map(async (a) => {
      try {
        const urlFor = (page) => (page.webui ? `${page.base || (base ? `${base}/wiki` : '')}${page.webui}` : null);
        let rec = await store.get(store.keys.samplePage(a.sampleKey));
        if (!rec?.id) {
          const title = samplePageTitle(a.vendor);
          let page = await jira.findPageByTitle(client, null, title); // throws on error: never create blind
          if (!page) {
            if (!createMissing) return;
            const sp = await space();
            if (!sp) return;
            // Per-sample lock so a concurrent install event and board open
            // cannot both create the page.
            if (!(await store.claim(store.keys.pageLock(a.sampleKey), { at: new Date().toISOString() }, 60))) return;
            try {
              page = (await jira.findPageByTitle(client, null, title)) || (await jira.createPage(client, { spaceId: sp.id, title, storage: samplePageBody(a) }));
              if (page) out.created.push(a.issueKey);
            } finally {
              await store.del(store.keys.pageLock(a.sampleKey)).catch(() => {});
            }
          }
          rec = { id: String(page.id), url: urlFor(page) };
          await store.set(store.keys.samplePage(a.sampleKey), rec);
        }
        await linkAgreementPage(client, a, rec.id, rec.url);
        out.linked.push(a.issueKey);
      } catch (e) {
        if (e instanceof ApiError && e.forbidden) out.forbidden = true;
        out.errors.push(`${a.issueKey}: ${e.message}`);
      }
    })
  );
  return out;
}

export async function hasRealData(client) {
  const agreements = await store.listAgreements();
  if (agreements.some((a) => !a.sample)) return true;
  const real = await jira
    .searchIssues(client, `labels = "${LABELS.AGREEMENT}" AND labels != "${LABELS.SAMPLE}"`, ['summary'], 1)
    .catch(() => []);
  return real.length > 0;
}

// Idempotent. Safe to call from the install trigger and from every board
// open. Skips for good once real data exists.
// `force` is only set by the explicit "Load samples" button: the person
// asked for samples, so the real-data skip does not apply.
export async function judgeModeSeed(client, source, { force = false } = {}) {
  const t0 = Date.now();
  const state = await store.get(store.keys.seed);
  if (state?.state === 'done' || (state?.state === 'skipped' && !force)) return { ...state, alreadyDone: true };
  const won = await store.claim(store.keys.seedLock, { source, at: new Date().toISOString() }, 90);
  if (!won) return { state: 'running' };
  try {
    await store.set(store.keys.seed, { state: 'running', at: new Date().toISOString(), source });
    // Independent discovery calls in parallel: they are the critical path.
    const [real, { cfg, reason }, base, space] = await Promise.all([
      hasRealData(client),
      resolveConfig(client),
      siteBase(client),
      jira.pickSpace(client).catch(() => null),
      jira.linkTypeNames(client).catch(() => null),
    ]);
    if (real && !force) {
      const s = { state: 'skipped', reason: 'real agreements exist', at: new Date().toISOString(), source };
      await store.set(store.keys.seed, s);
      return s;
    }
    if (!cfg) {
      const s = {
        state: reason || 'needs-project',
        at: new Date().toISOString(),
        source,
        ...(reason === 'no-permission' ? { message: PERMISSION_MESSAGE } : {}),
      };
      await store.set(store.keys.seed, s);
      return s;
    }
    const today = todayIso();
    const samples = buildSamples(today);
    const stamp = { at: new Date().toISOString(), source: `judge-mode (${source})`, reviewsCreated: 0, pings: 0, escalationsCreated: 0, errors: [] };
    const existing = await store.listEscalationKeys();

    // Each sample is its own chain, all in parallel. A Due sample escalates
    // inside its own chain the moment its blocker exists, so the board (which
    // polls while seeding) shows the Helios row and its escalation without
    // waiting for the other three. The review issue is opened alongside.
    const seedOne = async (s) => {
      const a = await ensureSample(client, s, cfg, space, base);
      if (evaluate(a, today).status !== STATUS.DUE) return a;
      await Promise.all([
        (async () => {
          try {
            const r = a.newBlocker
              ? await escalateAgreement(client, a, today, existing, { knownBlockers: [a.newBlocker], fresh: true })
              : await escalateAgreement(client, a, today, existing);
            stamp.escalationsCreated += r.created.length;
            stamp.errors.push(...r.errors);
          } catch (e) {
            stamp.errors.push(`${a.issueKey}: ${e.message}`);
          }
        })(),
        (async () => {
          try {
            if ((await ensureReviewIssue(client, a, { reason: 'judge mode' })).created) stamp.reviewsCreated += 1;
          } catch (e) {
            stamp.errors.push(`${a.issueKey}: ${e.message}`);
          }
        })(),
      ]);
      return a;
    };
    const ordered = [...samples].sort((x, y) => (y.blocker ? 1 : 0) - (x.blocker ? 1 : 0)); // Helios first
    const results = await Promise.allSettled(ordered.map(seedOne));
    const rejected = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
    const failed = rejected.map((e) => e?.message);
    const seeded = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    stamp.errors.unshift(...failed);
    await Promise.all(seeded.map((a) => a.pending).filter(Boolean));
    const scan = await saveStamp(stamp);
    // Nothing could be created because the user lacks permission: say so
    // instead of showing an empty board.
    if (!seeded.length && rejected.length && rejected.every((e) => e instanceof ApiError && e.permissionDenied)) {
      const s = { state: 'no-permission', message: PERMISSION_MESSAGE, at: new Date().toISOString(), source, errors: failed.slice(0, 3) };
      await store.set(store.keys.seed, s);
      return s;
    }
    const s = {
      state: failed.length ? 'partial' : 'done',
      version: SAMPLE_VERSION,
      at: new Date().toISOString(),
      source,
      ms: Date.now() - t0,
      errors: failed.slice(0, 5),
      escalationsCreated: scan.escalationsCreated,
    };
    await store.set(store.keys.seed, s);
    return s;
  } catch (e) {
    const s = { state: 'error', at: new Date().toISOString(), source, errors: [e.message] };
    await store.set(store.keys.seed, s).catch(() => {});
    if (e instanceof ApiError && e.forbidden) throw e; // install trigger retries on 401/403
    return s;
  } finally {
    await store.del(store.keys.seedLock).catch(() => {});
  }
}

// ---------- board data ----------

// ---------- fast first paint ----------

const SNAPSHOT_MAX_AGREEMENTS = 200;

// Per user, so a cached paint never shows an issue that user cannot open.
export async function saveSnapshot(accountId, board) {
  if (!accountId || !board || board.loadError) return;
  const data = { ...board, agreements: (board.agreements || []).slice(0, SNAPSHOT_MAX_AGREEMENTS) };
  delete data.seedResult;
  delete data.backfill;
  await store.set(store.keys.snapshot(accountId), { savedAt: new Date().toISOString(), data }).catch(() => {});
}

export async function getSnapshot(accountId) {
  if (!accountId) return null;
  const s = await store.get(store.keys.snapshot(accountId)).catch(() => null);
  return s?.data ? { ...s.data, fromSnapshot: true, savedAt: s.savedAt } : null;
}

export async function recordPaint({ ms, source, agreements }) {
  const entry = { ms: Math.round(Number(ms) || 0), source: String(source || ''), agreements: Number(agreements) || 0, at: new Date().toISOString() };
  console.log(`Fides first useful paint: ${entry.ms} ms from ${entry.source} (${entry.agreements} agreements)`);
  const prev = (await store.get(store.keys.paintMetrics).catch(() => null)) || [];
  await store.set(store.keys.paintMetrics, [entry, ...prev].slice(0, 20)).catch(() => {});
  return entry;
}

export async function boardData(client, { asUser, accountId = null } = {}) {
  const board = await computeBoard(client, { asUser });
  await saveSnapshot(accountId, board);
  return board;
}

async function computeBoard(client, { asUser }) {
  const today = todayIso();
  const [cfg, seed, lastRun, escKeys] = await Promise.all([
    store.get(store.keys.config),
    store.get(store.keys.seed),
    store.get(store.keys.lastRun),
    store.listEscalationKeys(),
  ]);
  const agreements = (await visibleAgreements(client, { asUser })).map((a) => evaluate(a, today));
  agreements.sort((a, b) => (a.invalid ? 1 : 0) - (b.invalid ? 1 : 0) || a.daysLeft - b.daysLeft);
  const escalations = [];
  for (const k of escKeys) {
    const v = await store.get(k);
    if (v?.issueKey) escalations.push(v);
  }
  const base = cfg?.baseUrl || (await siteBase(client).catch(() => ''));
  const visibleIds = new Set(agreements.map((a) => String(a.issueId)));
  // Due agreements carry their live open blockers and linked escalations, so
  // the first screen shows why a plain date reminder is not enough.
  await Promise.all(
    agreements
      .filter((a) => !a.invalid && a.status === STATUS.DUE)
      .slice(0, 10)
      .map(async (a) => {
        a.escalations = escalations
          .filter((e) => String(e.agreementId) === String(a.issueId))
          .map((e) => ({ issueKey: e.issueKey, url: browse(base, e.issueKey), blockerKey: e.blockerKey, dateAtRisk: e.dateAtRisk, riskKind: e.riskKind, notify: e.notify || null }));
        try {
          a.openBlockers = (await findBlockers(client, a))
            .filter(isBlockerOpen)
            .map((b) => ({ key: b.key, summary: b.summary, statusName: b.statusName, url: browse(base, b.key) }));
        } catch {
          // Fall back to what the escalation records know.
          a.openBlockers = a.escalations.map((e) => ({ key: e.blockerKey, summary: null, statusName: null, url: browse(base, e.blockerKey) }));
        }
      })
  );
  return {
    today,
    baseUrl: base,
    config: cfg || null,
    seed: seed || null,
    lastRun: lastRun || null,
    agreements,
    escalations: escalations
      .filter((e) => visibleIds.has(String(e.agreementId)))
      .map((e) => ({ ...e, url: browse(base, e.issueKey) })),
    counts: {
      due: agreements.filter((a) => a.status === STATUS.DUE).length,
      upcoming: agreements.filter((a) => a.status === STATUS.UPCOMING).length,
      onTrack: agreements.filter((a) => a.status === STATUS.ON_TRACK).length,
    },
    disclaimer: DISCLAIMER,
  };
}

// ---------- paste-rows import ----------

export async function previewImport(text) {
  return parseImport(text, await store.listAgreements());
}

// Import rows [from, to) of a paste, through the same createAgreement path
// as the board's Add agreement form. Re-parses on the server; never trusts
// a client-side preview. Batches of 5 in parallel; each row reports
// created, skipped or failed.
export async function importAgreements(client, text, { from = 0, to = MAX_ROWS, batchSize = 5 } = {}) {
  const parsed = parseImport(text, await store.listAgreements());
  if (!parsed.ok) return { ok: false, error: parsed.error, results: [] };
  const slice = parsed.rows.slice(from, Math.min(to, MAX_ROWS));
  const results = [];
  const createdKeys = new Set();
  for (let i = 0; i < slice.length; i += batchSize) {
    const batch = slice.slice(i, i + batchSize);
    const out = await Promise.all(
      batch.map(async (r) => {
        const base = { line: r.line, vendor: r.vendor, endDate: r.endDate };
        if (r.errors.length) return { ...base, status: 'failed', reason: r.errors.join(' ') };
        if (r.duplicate) return { ...base, status: 'skipped', reason: r.duplicate };
        const k = dupKey(r.vendor, r.endDate);
        if (createdKeys.has(k)) return { ...base, status: 'skipped', reason: 'Repeated earlier in this paste.' };
        createdKeys.add(k);
        try {
          const a = await createAgreement(client, {
            vendor: r.vendor,
            endDate: r.endDate,
            noticeDays: r.noticeDays,
            owner: r.owner,
            confluenceUrl: r.confluenceUrl,
            confluencePageId: jira.parsePageRef(r.confluenceUrl),
          });
          return { ...base, status: 'created', issueKey: a.issueKey, ownerResolution: a.ownerResolution || null };
        } catch (e) {
          createdKeys.delete(k);
          const msg = e instanceof ApiError && e.permissionDenied ? 'You do not have permission to create issues in the Fides project.' : e.message;
          return { ...base, status: 'failed', reason: msg };
        }
      })
    );
    results.push(...out);
  }
  const count = (st) => results.filter((x) => x.status === st).length;
  return { ok: true, results, counts: { created: count('created'), skipped: count('skipped'), failed: count('failed') }, total: parsed.rows.length };
}

// ---------- track an agreement from its Confluence page ----------

export const UNREADABLE_PAGE =
  'I cannot read this page. You may not have permission to view it, or Fides is not connected to Confluence on this site. Share the page with yourself or paste the dates and I will track it from those.';

async function locatePage(client, ref, contextContentId) {
  const id = jira.parsePageRef(ref) || (!ref || /^(this|this page|current page)$/i.test(String(ref).trim()) ? contextContentId : null);
  if (id) return jira.getPage(client, id);
  const found = await jira.findPageByTitle(client, null, String(ref).trim());
  return found ? jira.getPage(client, found.id) : null;
}

async function agreementForPage(pageId) {
  const rec = await store.get(store.keys.pageAgreement(pageId));
  if (rec?.issueId) {
    const a = await store.get(store.keys.agreement(rec.issueId));
    if (a) return a;
  }
  return (await store.listAgreements()).find((a) => String(a.confluencePageId) === String(pageId)) || null;
}

// Read a contract page as the user, propose structured fields with quoted
// sources, and create the agreement only when `confirm` is true. One
// agreement per page id: a second run returns the existing one.
export async function trackAgreementFromPage(client, { pageRef, contextContentId = null, confirm = false, overrides = {} } = {}) {
  let page;
  try {
    page = await locatePage(client, pageRef, contextContentId);
  } catch (e) {
    if (e instanceof ApiError && (e.forbidden || e.notFound)) return { status: 'unreadable', message: UNREADABLE_PAGE };
    throw e;
  }
  if (!page) return { status: 'not-found', message: `I could not find a Confluence page called "${pageRef}". Paste the page link instead.` };
  const url = page.base && page.webui ? `${page.base}${page.webui}` : null;
  const pageInfo = { id: String(page.id), title: page.title, url };

  const existing = await agreementForPage(page.id);
  if (existing) {
    return {
      status: 'existing',
      page: pageInfo,
      agreement: { issueKey: existing.issueKey, vendor: existing.vendor, endDate: existing.endDate, noticeDays: existing.noticeDays },
      message: `This page is already tracked as ${existing.issueKey} ${existing.vendor}. Nothing new was created.`,
    };
  }

  const ex = extractAgreement({ title: page.title, storage: page.storage, text: storageToText(page.storage) });
  const proposal = { ...ex.fields };
  // The agent (or the user) can fill or correct any field.
  const merged = {
    vendor: overrides.vendor ?? proposal.vendor?.value ?? null,
    endDate: overrides.endDate ?? proposal.endDate?.value ?? null,
    noticeDays: overrides.noticeDays ?? proposal.noticeDays?.value ?? null,
    owner: overrides.owner ?? proposal.owner?.value ?? '',
    obligations: overrides.obligations ?? proposal.obligations.map((o) => o.value).join(' '),
  };
  for (const k of ['vendor', 'endDate', 'noticeDays', 'owner']) {
    if (overrides[k] !== undefined && overrides[k] !== null && overrides[k] !== '') {
      proposal[k] = { value: overrides[k], source: 'Provided in Rovo Chat', confidence: 'confirmed' };
    }
  }
  const missing = ['vendor', 'endDate', 'noticeDays'].filter((k) => merged[k] === null || merged[k] === '');
  const lowConfidence = ex.lowConfidence.filter((k) => overrides[k] === undefined);

  if (!confirm) {
    return {
      status: 'proposal',
      page: pageInfo,
      proposal,
      missing,
      lowConfidence,
      sourceLine: `Source: ${page.title}${url ? ` (${url})` : ''}`,
      nextStep: missing.length
        ? `Ask the user for: ${missing.join(', ')}. Then call again with confirm true and those values.`
        : 'Show this proposal with the quoted sources, flag low-confidence fields, and ask the user to confirm or correct. Then call again with confirm true.',
    };
  }
  if (missing.length) return { status: 'needs-input', page: pageInfo, missing, message: `I still need: ${missing.join(', ')}.` };

  // Concurrency guard so two confirmations cannot create two agreements.
  if (!(await store.claim(store.keys.trackLock(page.id), { at: new Date().toISOString() }, 60))) {
    return { status: 'busy', page: pageInfo, message: 'This page is being tracked right now. Ask again in a moment.' };
  }
  try {
    const again = await agreementForPage(page.id);
    if (again) return { status: 'existing', page: pageInfo, agreement: { issueKey: again.issueKey, vendor: again.vendor }, message: `This page is already tracked as ${again.issueKey} ${again.vendor}.` };
    const a = await createAgreement(client, {
      vendor: merged.vendor,
      endDate: merged.endDate,
      noticeDays: Number(merged.noticeDays),
      owner: merged.owner,
      ownerAccountId: overrides.ownerAccountId || null,
      obligations: merged.obligations,
      confluencePageId: String(page.id),
      confluenceUrl: url,
    });
    if (a.pending) await a.pending;
    await store.set(store.keys.pageAgreement(page.id), { issueId: a.issueId });
    const base = await siteBase(client).catch(() => '');
    return {
      status: 'created',
      page: pageInfo,
      agreement: { issueKey: a.issueKey, vendor: a.vendor, endDate: a.endDate, noticeDays: a.noticeDays, url: browse(base, a.issueKey) },
      message: `Tracking ${a.vendor} as ${a.issueKey}, linked to "${page.title}".`,
    };
  } finally {
    await store.del(store.keys.trackLock(page.id)).catch(() => {});
  }
}

export { upcomingNotices, DEFAULT_LOOKAHEAD_DAYS };
