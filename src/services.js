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
  dateAtRisk,
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
  // The structured record also lives on the Jira issue, so a reinstall
  // (empty app storage) can rebuild it instead of creating a duplicate.
  const propWrite = jira.setIssueProperty(client, issue.key, AGREEMENT_PROP, propertyRecord(record)).catch(() => {});
  if (!sample) await propWrite;
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
    else saved.pending = Promise.all([link, propWrite]);
  } else if (sample) {
    saved.pending = propWrite;
  }
  return saved;
}

// Agreements the caller can see. With a user client this filters by Jira
// browse permission, so the board and Rovo never show issues the user
// cannot open.
export async function visibleAgreements(client, { asUser } = {}) {
  return loadAgreements(client, { asUser });
}

const AGREEMENT_FIELDS = ['summary', 'labels', 'status', 'project', 'description', 'created'];

// Jira, not app storage, is the source of truth for reads. App storage is
// per product install (the Confluence install's is empty), so an empty
// store must never mean "no agreements". Loads every fides-agreement issue
// the caller can see (JQL is permission-aware for a user client), builds
// each record from the issue property (or the description), overlays what
// this install's storage knows, and hydrates storage with what it lacked.
export async function loadAgreements(client, { hydrate = true } = {}) {
  const [issues, cached] = await Promise.all([
    jira.searchAll(client, `labels = "${LABELS.AGREEMENT}" ORDER BY created ASC`, AGREEMENT_FIELDS, [AGREEMENT_PROP]),
    store.listAgreements(),
  ]);
  const byId = new Map(cached.filter((a) => a?.issueId).map((a) => [String(a.issueId), a]));
  const out = [];
  const seenSample = new Set();
  const toHydrate = [];
  const add = (rec, kv) => {
    // One sample per sample key (the oldest), matching ensureSample.
    if (rec.sample && rec.sampleKey) {
      if (seenSample.has(rec.sampleKey)) return;
      seenSample.add(rec.sampleKey);
    }
    out.push(rec);
    if (!kv || (rec.hasProperty && PROP_FIELDS.some((k) => (kv[k] ?? null) !== (rec[k] ?? null)))) toHydrate.push(rec);
  };
  for (const issue of issues) add(mergeRecord(recordFromIssue(issue), byId.get(String(issue.id))), byId.get(String(issue.id)));

  // Created moments ago and not in the search index yet (JQL is eventually
  // consistent): confirm with a permission-aware bulk fetch, which is not.
  const inJql = new Set(issues.map((i) => String(i.id)));
  const pending = cached.filter((a) => a?.issueId && !inJql.has(String(a.issueId)));
  for (let i = 0; i < pending.length; i += 100) {
    const found = await jira.bulkFetch(client, pending.slice(i, i + 100).map((a) => String(a.issueId)), ['summary', 'labels']).catch(() => []);
    const ok = new Set(found.map((f) => String(f.id)));
    for (const a of pending.slice(i, i + 100)) if (ok.has(String(a.issueId))) add(a, a);
  }
  if (hydrate && toHydrate.length) await Promise.all(toHydrate.map((r) => store.saveAgreement(r).catch(() => {})));
  return out;
}

// The issue property is shared by every product install; where it has a
// value it wins. Otherwise this install's storage fills gaps the
// description could not.
function mergeRecord(fromIssue, kv) {
  if (!kv) return fromIssue;
  const merged = { ...fromIssue, ...Object.fromEntries(Object.entries(kv).filter(([, v]) => v !== null && v !== undefined && v !== '')) };
  if (fromIssue.hasProperty) for (const k of PROP_FIELDS) if (fromIssue[k] !== null && fromIssue[k] !== undefined && fromIssue[k] !== '') merged[k] = fromIssue[k];
  for (const k of ['issueId', 'issueKey', 'projectId', 'projectKey', 'summary', 'sample', 'hasProperty']) merged[k] = fromIssue[k] ?? merged[k];
  merged.propertyPageId = fromIssue.propertyPageId;
  return merged;
}

// Escalations from this install's storage merged with Jira: one JQL on the
// fides-escalation label, keyed by the fides-esc-<agreementId>-<blockerId>
// label (oldest issue wins). Pairs this install did not know are written to
// storage, so escalateAgreement treats them as existing (no duplicates).
export async function loadEscalations(client) {
  const [keys, issues] = await Promise.all([
    store.listEscalationKeys(),
    jira.searchAll(client, `labels = "${LABELS.ESCALATION}" ORDER BY created ASC`, ['summary', 'labels', 'status', 'issuelinks', 'created']).catch(() => []),
  ]);
  const byKey = new Map();
  await Promise.all(
    [...keys].map(async (k) => {
      const v = await store.get(k).catch(() => null);
      if (v?.issueKey) byKey.set(k, v);
    })
  );
  const hydrate = [];
  for (const i of issues) {
    const m = i.labels.map((l) => /^fides-esc-(\d+)-(\d+)$/.exec(l)).find(Boolean);
    if (!m) continue;
    const k = escalationKey(m[1], m[2]);
    if (byKey.has(k)) continue;
    const blocker = i.links.find((l) => String(l.id) === String(m[2]));
    const rec = { state: 'done', issueKey: i.key, agreementId: m[1], blockerId: m[2], blockerKey: blocker?.key || null, riskKind: 'notice', adopted: true, at: i.created || new Date().toISOString() };
    byKey.set(k, rec);
    hydrate.push([k, rec]);
  }
  // set, not claim: a stuck in-flight 'creating' row must be overwritten
  // once Jira already has the labelled escalation issue.
  await Promise.all(hydrate.map(([k, v]) => store.set(k, v).catch(() => {})));
  return [...byKey.entries()].map(([k, v]) => ({ key: k, ...v }));
}

// Resolve an agreement reference (vendor name first, then issue key or id;
// see lib/match.js). Kept as a thin wrapper for the UI resolvers.
export function resolveAgreement(agreements, ref, contextIssueKey) {
  return matchAgreement(agreements, ref, contextIssueKey).agreement;
}

// ---------- blockers ----------

export async function findBlockers(client, agreement) {
  const found = await findLinkedWithLabel(client, agreement.issueKey, LABELS.BLOCKER);
  return found.map((b) => ({ id: b.id, key: b.key, summary: b.summary, statusCategory: b.statusCategory, statusName: b.statusName }));
}

// ---------- review issues ----------

export async function ensureReviewIssue(client, agreement, { reason = 'notice window', fresh = false } = {}) {
  const base = await siteBase(client);
  const reviewKey = store.keys.review(agreement.issueId);
  const adoptOpen = async (issueKey, extra = {}) => {
    await store.set(reviewKey, { issueKey, at: new Date().toISOString(), adopted: true, ...extra });
    return { created: false, issueKey, url: browse(base, issueKey) };
  };
  const existing = await store.get(reviewKey);
  if (existing?.issueKey) {
    try {
      const i = await jira.getIssue(client, existing.issueKey);
      if (i.statusCategory !== 'done') return { created: false, issueKey: i.key, url: browse(base, i.key) };
    } catch (e) {
      if (!e.notFound) throw e;
    }
  }
  // App storage may be empty (reinstall): ask Jira for an open review
  // linked to this agreement before creating one.
  // (Skipped for an agreement created moments ago in this run: it cannot
  // have a review yet, and judge mode's cold start stays fast.)
  const linkedReviews = fresh ? [] : await findLinkedWithLabel(client, agreement.issueKey, LABELS.REVIEW).catch(() => []);
  const openReview = linkedReviews.find((r) => r.statusCategory !== 'done');
  if (openReview) return adoptOpen(openReview.key);

  const won = await store.claim(reviewKey, { state: 'creating', at: new Date().toISOString() }, store.CLAIM_TTL_SECONDS);
  if (!won) {
    const again = fresh ? [] : await findLinkedWithLabel(client, agreement.issueKey, LABELS.REVIEW).catch(() => []);
    const open = again.find((r) => r.statusCategory !== 'done');
    if (open) return adoptOpen(open.key);
    const latest = await store.get(reviewKey);
    if (latest?.issueKey) return { created: false, issueKey: latest.issueKey, url: browse(base, latest.issueKey) };
    return { created: false, issueKey: null, pending: true };
  }
  try {
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
    await store.set(reviewKey, { issueKey: issue.key, at: new Date().toISOString(), notify: issue.notify });
    return { created: true, issueKey: issue.key, url: browse(base, issue.key), notify: issue.notify };
  } catch (e) {
    await store.del(reviewKey).catch(() => {});
    throw e;
  }
}

// ---------- threatened-milestone escalation ----------

// Rewrite the "Contract page:" line on a Fides escalation issue when the
// agreement now has a Confluence URL. Idempotent: no write if the line
// already links that URL. Never touches non-escalation issues.
export function contractPageParagraph(url) {
  return url ? adf.p('Contract page: ', adf.link(url, url)) : adf.p('Contract page: not linked yet.');
}

export function needsContractPageHeal(description, url) {
  if (!url) return false;
  const text = jira.adfText(description);
  return text.includes('Contract page: not linked yet') || !text.includes(url);
}

export function withContractPageLink(description, url) {
  const blocks = description?.type === 'doc' && Array.isArray(description.content) ? description.content : [];
  let replaced = false;
  const content = blocks.map((block) => {
    if (/^\s*Contract page:/.test(jira.adfText(block))) {
      replaced = true;
      return contractPageParagraph(url);
    }
    return block;
  });
  if (!replaced) content.push(contractPageParagraph(url));
  return { type: 'doc', version: 1, content };
}

export async function healEscalationContractPage(client, issueKey, url) {
  if (!issueKey || !url) return { updated: false };
  const issue = await jira.getIssue(client, issueKey);
  if (!(issue.labels || []).includes(LABELS.ESCALATION)) return { updated: false, skipped: 'not-escalation' };
  if (!needsContractPageHeal(issue.description, url)) return { updated: false };
  await jira.updateIssue(client, issueKey, { description: withContractPageLink(issue.description, url) });
  return { updated: true, issueKey };
}

export async function pageUrlFromRemoteLinks(client, issueKey) {
  if (!issueKey) return null;
  const links = await jira.getRemoteLinks(client, issueKey).catch(() => []);
  const hit = links.find((l) => {
    const url = l.object?.url || l.url || '';
    return /\/wiki\//.test(url) || /\/pages\/\d+/.test(url);
  });
  return hit?.object?.url || hit?.url || null;
}

export async function agreementPageUrl(client, agreement) {
  if (agreement?.confluenceUrl) return agreement.confluenceUrl;
  if (!agreement?.issueKey) return null;
  return pageUrlFromRemoteLinks(client, agreement.issueKey);
}

export async function healEscalationContractPages(client, agreements) {
  const list = (agreements || []).filter((a) => a?.issueId && a.issueKey);
  if (!list.length) return { updated: 0 };
  const escalations = await loadEscalations(client).catch(() => []);
  let updated = 0;
  for (const a of list) {
    const url = await agreementPageUrl(client, a);
    if (!url) continue;
    for (const e of escalations) {
      if (String(e.agreementId) !== String(a.issueId) || !e.issueKey) continue;
      const r = await healEscalationContractPage(client, e.issueKey, url).catch(() => ({ updated: false }));
      if (r.updated) updated += 1;
    }
  }
  return { updated };
}

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
      if (v?.issueKey) {
        out.existing.push({ issueKey: v.issueKey, blockerKey: b.key });
        const url = await agreementPageUrl(client, agreement);
        if (url) await healEscalationContractPage(client, v.issueKey, url).catch(() => {});
      }
    }
  }
  if (!plans.length) return out;
  const base = await siteBase(client);
  const cfg = await ensureConfig(client);
  const types = await jira.linkTypeNames(client);
  for (const plan of plans) {
    const won = await store.claim(plan.key, { state: 'creating', at: new Date().toISOString() }, store.CLAIM_TTL_SECONDS);
    if (!won) {
      // Lost the claim: adopt the labelled issue if a crashed run left one,
      // otherwise skip until the in-flight TTL expires.
      const dup = fresh ? [] : await jira.searchIssues(client, `labels = "${plan.label}"`, ['summary'], 1);
      if (dup[0]?.key) {
        const issueKey = dup[0].key;
        await store.set(plan.key, {
          state: 'done',
          issueKey,
          agreementId: agreement.issueId,
          agreementKey: agreement.issueKey,
          vendor: agreement.vendor,
          blockerKey: plan.blocker.key,
          dateAtRisk: plan.risk.date,
          riskKind: plan.risk.kind,
          adopted: true,
          at: new Date().toISOString(),
        });
        existing.add(plan.key);
        out.existing.push({ issueKey, blockerKey: plan.blocker.key });
        const url = await agreementPageUrl(client, agreement);
        if (url) await healEscalationContractPage(client, issueKey, url).catch(() => {});
      }
      continue;
    }
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
            contractPageParagraph(agreement.confluenceUrl),
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
      } else {
        const url = await agreementPageUrl(client, agreement);
        if (url) await healEscalationContractPage(client, issueKey, url).catch(() => {});
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
  const existing = new Set((await loadEscalations(client)).map((e) => e.key));
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

export async function runScan(client, source, { writeClient = null } = {}) {
  const startedAt = new Date().toISOString();
  const today = todayIso();
  const stamp = { at: startedAt, source, ok: true, reviewsCreated: 0, pings: 0, escalationsCreated: 0, errors: [] };
  try {
    const bf = await backfillSamplePages(client, { source: 'scan', writeClient: writeClient || client }).catch((e) => ({ errors: [e.message] }));
    stamp.pagesLinked = bf.linked?.length || 0;
    const agreements = await loadAgreements(client);
    // Escalations first: they are the time-critical signal.
    const esc = await escalateAll(client, agreements, today);
    stamp.escalationsCreated = esc.created.length;
    await healEscalationContractPages(client, agreements).catch(() => {});
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

export const AGREEMENT_PROP = 'fides-agreement';
const PROP_FIELDS = ['vendor', 'endDate', 'noticeDays', 'milestoneDate', 'spend', 'owner', 'ownerAccountId', 'obligations', 'confluencePageId', 'confluenceUrl', 'sample', 'sampleKey'];
const propertyRecord = (r) => Object.fromEntries([['v', 1], ...PROP_FIELDS.map((k) => [k, r[k] ?? null])]);

// Rebuild an agreement record from its Jira issue: the issue property when
// present, else the fixed-format description Fides writes, else the
// sample definition. Used when app storage is empty (reinstall, or a second
// product install with its own storage).
export function recordFromIssue(issue, def = null) {
  const prop = issue.properties?.[AGREEMENT_PROP];
  const labels = issue.labels || [];
  const text = issue.descriptionText || '';
  const grab = (re) => re.exec(text)?.[1]?.trim() ?? null;
  const parsed = {
    endDate: grab(/End date: (\d{4}-\d{2}-\d{2})\./),
    noticeDays: grab(/Notice period: (\d+) days\./),
    spend: grab(/Spend: (.*?)\. Owner:/),
    owner: grab(/Owner: ([^\n]*?)\.\s*(?:\n|$)/),
    obligations: grab(/Key obligations: ([^\n]*)/),
    confluenceUrl: grab(/Contract page: (https?:\/\/\S+)/),
  };
  const base = prop || {};
  const pick = (k) => base[k] ?? (parsed[k] && parsed[k] !== 'n/a' ? parsed[k] : null) ?? def?.[k] ?? null;
  const vendor = base.vendor || def?.vendor || String(issue.summary || '').split(' agreement')[0];
  const confluenceUrl = pick('confluenceUrl');
  return {
    vendor,
    endDate: pick('endDate'),
    noticeDays: Number(pick('noticeDays')),
    milestoneDate: base.milestoneDate || null,
    spend: pick('spend') || '',
    owner: pick('owner') || '',
    ownerAccountId: base.ownerAccountId || null,
    ownerResolution: base.ownerAccountId ? 'picked' : 'none',
    obligations: pick('obligations') || '',
    confluencePageId: base.confluencePageId ? String(base.confluencePageId) : jira.parsePageRef(confluenceUrl) || null,
    confluenceUrl,
    sample: labels.includes(LABELS.SAMPLE) || base.sample === true,
    sampleKey: base.sampleKey || def?.sampleKey || labels.map((l) => /^fides-sample-([a-z0-9]+)$/.exec(l)?.[1]).find(Boolean) || null,
    hasProperty: Boolean(prop),
    // What the shared issue property itself says (may lag the record).
    propertyPageId: prop?.confluencePageId ? String(prop.confluencePageId) : null,
    summary: issue.summary,
    issueId: issue.id,
    issueKey: issue.key,
    projectId: issue.projectId,
    projectKey: issue.projectKey,
    rebuiltFromJira: true,
  };
}

// The oldest live sample agreement issue for a sample key, if any.
async function findSampleIssue(client, sampleKey) {
  const found = await jira.searchIssues(
    client,
    `labels = "${sampleLabel(sampleKey)}" AND labels = "${LABELS.AGREEMENT}" ORDER BY created ASC`,
    ['summary', 'labels', 'status', 'project', 'description', 'created'],
    1,
    [AGREEMENT_PROP]
  );
  return found[0] || null;
}

// Issues linked to an agreement that carry a label, oldest first.
// Every linked issue with `label`, oldest first. Paged via bulkFetch (100
// keys at a time) so a cap cannot hide an existing review or blocker and
// cause a duplicate create. Bad or hidden keys are skipped, not fatal.
export async function findLinkedWithLabel(client, agreementKey, label) {
  const issue = await jira.getIssue(client, agreementKey);
  const keys = [...new Set(issue.links.map((l) => l.key).filter(Boolean))];
  if (!keys.length) return [];
  const found = [];
  for (let i = 0; i < keys.length; i += 100) {
    const batch = await jira.bulkFetch(client, keys.slice(i, i + 100), ['summary', 'status', 'labels', 'created']);
    found.push(...batch.filter((r) => (r.labels || []).includes(label)));
  }
  found.sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')) || String(a.id).localeCompare(String(b.id)));
  return found;
}

// Jira is the single source of truth: reuse the sample issue if Jira has
// one (rebuilding the app record from it), never create a second. Same for
// the sample blocker (label + link). Creation only happens when Jira has
// none; the caller holds the seed lock.
async function ensureSample(client, s, cfg, space, base) {
  const title = samplePageTitle(s.vendor);
  const [existingIssue, existingPage] = await Promise.all([
    findSampleIssue(client, s.sampleKey),
    // Any space: a sample page may live outside the space pickSpace returns.
    space ? jira.findPageByTitle(client, null, title).catch(() => null) : null,
  ]);

  if (existingIssue) {
    const cached = await store.get(store.keys.agreement(existingIssue.id));
    let agreement = cached || recordFromIssue(existingIssue, s);
    if (!agreement.confluencePageId && existingPage?.id) {
      // the page exists but this record never learnt it: the backfill links it later
    }
    agreement = await store.saveAgreement(agreement);
    await store.set(store.keys.sample(s.sampleKey), { issueId: agreement.issueId });
    if (!cached) jira.setIssueProperty(client, agreement.issueKey, AGREEMENT_PROP, propertyRecord(agreement)).catch(() => {});
    if (s.blocker) {
      const blockers = await findLinkedWithLabel(client, agreement.issueKey, LABELS.BLOCKER).catch(() => null);
      if (blockers === null) return agreement; // could not check: never create blind
      if (blockers.length) {
        if (agreement.sampleBlockerKey !== blockers[0].key) agreement = await store.saveAgreement({ ...agreement, sampleBlockerKey: blockers[0].key });
        return agreement;
      }
      return createSampleBlocker(client, s, cfg, agreement);
    }
    return agreement;
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
  const out = s.blocker ? await createSampleBlocker(client, s, cfg, agreement) : agreement;
  out.justCreated = true; // in memory only, never stored
  return out;
}

async function createSampleBlocker(client, s, cfg, agreement) {
  const blocker = await jira.createIssue(client, {
    projectId: cfg.projectId,
    issueTypeId: cfg.issueTypeId,
    summary: s.blocker.summary,
    description: adf.doc(adf.p(s.blocker.description), adf.p(adf.em('Sample blocker created by Fides judge mode.'))),
    labels: [LABELS.BLOCKER, LABELS.SAMPLE, `${sampleLabel(s.sampleKey)}-blocker`],
  });
  const types = await jira.linkTypeNames(client);
  await jira.linkIssues(client, types.blocks, blocker.key, agreement.issueKey);
  const { pending, newBlocker: _nb, ...record } = agreement;
  const saved = { ...(await store.saveAgreement({ ...record, sampleBlockerKey: blocker.key })), pending };
  saved.newBlocker = { id: blocker.id, key: blocker.key, summary: s.blocker.summary, statusCategory: 'new', statusName: 'To Do' };
  return saved;
}

// ---------- Confluence link backfill ----------

// Attach a Confluence page to an agreement: remote link on the agreement
// (required) and on its review and escalation issues (best effort), then
// store the page id. Remote links use a stable globalId, so a rerun updates
// rather than duplicates.
export async function linkAgreementPage(client, agreement, pageId, url) {
  const title = `Contract page: ${agreement.vendor}`;
  const gid = jira.pageGlobalId(pageId);
  await jira.addRemoteLink(client, agreement.issueKey, url, title, gid);
  const related = [];
  const review = await store.get(store.keys.review(agreement.issueId));
  if (review?.issueKey) related.push(review.issueKey);
  for (const e of await loadEscalations(client).catch(() => [])) {
    if (String(e.agreementId) === String(agreement.issueId) && e.issueKey) related.push(e.issueKey);
  }
  await Promise.all(
    [...new Set(related)].map(async (key) => {
      await jira.addRemoteLink(client, key, url, title, gid).catch(() => {});
      await healEscalationContractPage(client, key, url).catch(() => {});
    })
  );
  const fresh = (await store.get(store.keys.agreement(agreement.issueId))) || agreement;
  const saved = await store.saveAgreement({ ...fresh, confluencePageId: String(pageId), confluenceUrl: url });
  await store.set(store.keys.pageAgreement(pageId), { issueId: saved.issueId });
  // Shared by every product install: write the page onto the issue property.
  await writeAgreementProperty(client, saved);
  return saved;
}

export async function writeAgreementProperty(client, record) {
  try {
    await jira.setIssueProperty(client, record.issueKey, AGREEMENT_PROP, propertyRecord(record));
  } catch (e) {
    console.warn(`Fides ${record.issueKey}: could not update the agreement issue property: ${e.message}`);
  }
}

// ---------- sample pages match the Jira dates ----------

const SAMPLE_PAGE_PREFIX = 'Fides sample contract:';
const pageMatchesRecord = (storage, a) =>
  String(storage || '').includes(`<td>${a.endDate}</td>`) && String(storage || '').includes(`<td>${a.noticeDays} days</td>`);

// If a sample page's body dates differ from its Jira record (pages written
// by an earlier seed), rewrite that page in place: same id, next version,
// body from samplePageBody. Never creates a page, never touches a page that
// is not a Fides sample page. Remembered per page so it runs once.
//
// Reads use `client`. The rewrite uses `writeClient` (the app client): the
// Fides app created these pages, and the signed-in user can read them but
// usually cannot edit them (Confluence answers 404 for a read-only user).
// The guard is unchanged: a sample agreement, its linked page id, and a page
// titled "Fides sample contract: ...". Nothing else is ever written.
export async function syncSamplePage(client, agreement, { force = false, writeClient = client } = {}) {
  if (!agreement?.sample || !agreement.confluencePageId || !agreement.endDate) return 'skipped';
  const marker = `${agreement.endDate}|${agreement.noticeDays}`;
  const k = `pageSynced:${agreement.confluencePageId}`;
  if (!force && (await store.get(k).catch(() => null)) === marker) return 'in-sync';
  const page = await jira.getPage(client, agreement.confluencePageId);
  if (!String(page.title || '').startsWith(SAMPLE_PAGE_PREFIX)) return 'not-a-sample-page';
  let result = 'in-sync';
  if (!pageMatchesRecord(page.storage, agreement)) {
    try {
      await jira.updatePage(writeClient, { id: page.id, title: page.title, storage: samplePageBody(agreement), version: page.version ?? 1 });
    } catch (e) {
      e.stage = 'write';
      throw e;
    }
    result = 'updated';
  }
  await store.set(k, marker).catch(() => {});
  return result;
}

// Do the sample pages need a sync? Read-only: reads each page, never writes.
export async function samplePagesStale(client, agreements) {
  const out = [];
  for (const a of agreements.filter((x) => x.sample && x.confluencePageId && x.endDate)) {
    try {
      const page = await jira.getPage(client, a.confluencePageId);
      if (String(page.title || '').startsWith(SAMPLE_PAGE_PREFIX) && !pageMatchesRecord(page.storage, a)) out.push(a.issueKey);
    } catch {
      // unreadable: not reported as stale
    }
  }
  return out;
}

// Confluence is reached through the install the code is running in. From the
// Jira install the call may be refused; remember that for an hour instead of
// failing on every board open, and say so in the logs.
const CONFLUENCE_DOWN = 'cap:confluenceSyncFailed';

export async function syncSamplePages(client, agreements, { source = 'unknown', force = false, writeClient = client } = {}) {
  const out = { updated: [], inSync: [], errors: [], skipped: null };
  const targets = agreements.filter((a) => a.sample && a.confluencePageId);
  if (!targets.length) {
    console.log(`Fides page sync (${source}): nothing to do, no sample agreement has a linked page`);
    return out;
  }
  const down = force ? null : await store.get(CONFLUENCE_DOWN).catch(() => null);
  if (down) {
    out.skipped = `Confluence calls failed recently from this install (${down.message}); retrying after ${down.retryAfter}`;
    console.log(`Fides page sync (${source}): skipped. ${out.skipped}`);
    return out;
  }
  console.log(`Fides page sync (${source}): start, ${targets.length} sample page(s)`);
  await Promise.all(
    targets.map(async (a) => {
      try {
        const r = await syncSamplePage(client, a, { force, writeClient });
        if (r === 'updated') out.updated.push(a.issueKey);
        else out.inSync.push(a.issueKey);
        if (r === 'updated') console.log(`Fides page sync (${source}): updated page ${a.confluencePageId} for ${a.issueKey} in place`);
      } catch (e) {
        out.errors.push(`${a.issueKey}: ${e.message}`);
        console.warn(`Fides page sync (${source}): ${e.stage === 'write' ? 'app write' : 'read'} failed for ${a.issueKey}, page ${a.confluencePageId}: ${e.status ? `HTTP ${e.status} ` : ''}${e.message}`);
        if (e.stage !== 'write') out.readFailures = (out.readFailures || 0) + 1;
      }
    })
  );
  // Only failed READS mean "Confluence is unreachable from this install"; a
  // failed write on a page we could read is reported, not cached.
  if (out.readFailures && !out.updated.length && !out.inSync.length) {
    const retryAfter = new Date(Date.now() + 3600 * 1000).toISOString();
    await store.kvsSetTtl(CONFLUENCE_DOWN, { message: out.errors[0].slice(0, 160), retryAfter }, 3600).catch(() => {});
    console.warn(`Fides page sync (${source}): every page failed, so Confluence calls look unavailable from this install; will retry after ${retryAfter}`);
  }
  console.log(`Fides page sync (${source}): done, updated=${out.updated.length} inSync=${out.inSync.length} failed=${out.errors.length}`);
  return out;
}

// Sample agreements seeded before Confluence was reachable (for example the
// Jira install ran before Confluence was connected) have no page. Find each
// sample page by the stored page record or by exact title in any space, and
// create it only if Confluence answered that none exists. Never duplicates
// pages; does nothing (no API calls) when every sample is already linked.
export async function backfillSamplePages(client, opts = {}) {
  const { createMissing = true } = opts;
  const out = { linked: [], created: [], errors: [], forbidden: false, synced: [], syncErrors: [], syncSkipped: null };
  const all = await loadAgreements(client);
  const todo = all.filter((a) => a.sample && a.sampleKey && a.issueKey && !a.confluencePageId);
  // Linked, but the shared issue property never learnt the page (written by
  // an older version into one install's storage only): heal it.
  for (const a of all.filter((x) => x.confluencePageId && x.confluenceUrl && x.issueKey && x.propertyPageId !== String(x.confluencePageId))) {
    try {
      await linkAgreementPage(client, a, String(a.confluencePageId), a.confluenceUrl);
      a.propertyPageId = String(a.confluencePageId);
      out.healed = [...(out.healed || []), a.issueKey];
    } catch (e) {
      out.errors.push(`${a.issueKey}: ${e.message}`);
    }
  }
  const sync = async () => {
    const list = out.linked.length ? await loadAgreements(client, { hydrate: false }).catch(() => all) : all;
    const r = await syncSamplePages(client, list, { source: opts.source || 'backfill', force: opts.force === true, writeClient: opts.writeClient || client });
    out.synced = r.updated;
    out.syncErrors = r.errors;
    out.syncSkipped = r.skipped;
  };
  if (!todo.length) {
    await sync();
    return out;
  }
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
  await sync();
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
export async function judgeModeSeed(client, source, { force = false, writeClient = null } = {}) {
  const t0 = Date.now();
  const state = await store.get(store.keys.seed);
  // `force` (the explicit Load samples button) re-runs even after "done":
  // seeding adopts whatever Jira already has, so re-running is safe.
  if (!force && (state?.state === 'done' || state?.state === 'skipped')) return { ...state, alreadyDone: true };
  // Concurrency guard: a short-lived lock (FAIL_IF_EXISTS, 60 s TTL), then a
  // re-check of the seed state, then a Jira lookup per sample under the lock
  // (ensureSample), so two runs that start together cannot both create.
  const won = await store.claim(store.keys.seedLock, { source, at: new Date().toISOString() }, 60);
  if (!won) return { state: 'running' };
  const recheck = await store.get(store.keys.seed);
  if (!force && (recheck?.state === 'done' || recheck?.state === 'skipped')) {
    await store.del(store.keys.seedLock).catch(() => {});
    return { ...recheck, alreadyDone: true };
  }
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
            if ((await ensureReviewIssue(client, a, { reason: 'judge mode', fresh: a.justCreated === true })).created) stamp.reviewsCreated += 1;
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
    // Pages left by an earlier seed may carry older dates: match them to Jira.
    await syncSamplePages(client, seeded, { source: `seed (${source})`, writeClient: writeClient || client }).catch(() => {});
    // Nothing could be created because the user lacks permission: say so
    // instead of showing an empty board.
    if (!seeded.length && rejected.length && rejected.every((e) => e instanceof ApiError && e.permissionDenied)) {
      const s = { state: 'no-permission', message: PERMISSION_MESSAGE, at: new Date().toISOString(), source, errors: failed.slice(0, 3) };
      await store.set(store.keys.seed, s);
      return s;
    }
    const s = {
      adopted: seeded.filter((a) => a.rebuiltFromJira || !a.justCreated).length,
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

// Cap on the per-user first-paint snapshot. Agreements past this are still
// loaded live; only the cached first paint is truncated. Paint metrics keep
// the last 20 entries (see recordPaint).
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

async function agreementFromIssue(client, issue) {
  if (!issue || !(issue.labels || []).includes(LABELS.AGREEMENT)) return null;
  if (!issue.properties?.[AGREEMENT_PROP]) {
    const value = await jira.getIssueProperty(client, issue.key, AGREEMENT_PROP).catch(() => null);
    if (value) issue = { ...issue, properties: { ...(issue.properties || {}), [AGREEMENT_PROP]: value } };
  }
  return recordFromIssue(issue);
}

// Issue panel. KVS is a cache: on a cold install (empty store) fall back
// to the fides-agreement issue property and labels, including when this
// issue is a review, blocker or escalation linked to an agreement.
export async function panelData(client, { issueId, issueKey }) {
  const today = todayIso();
  const base = await siteBase(client).catch(() => '');
  const none = { kind: 'none', disclaimer: DISCLAIMER };
  const asAgreement = (rec) => ({ kind: 'agreement', agreement: evaluate(rec, today), baseUrl: base, disclaimer: DISCLAIMER });
  const direct = issueId ? await store.get(store.keys.agreement(issueId)) : null;
  if (direct) return asAgreement(direct);

  let issue;
  try {
    issue = await jira.getIssue(client, issueKey || issueId);
  } catch {
    return none;
  }
  const fromThis = await agreementFromIssue(client, issue);
  if (fromThis) return asAgreement(fromThis);

  for (const l of issue.links || []) {
    let rec = l.id ? await store.get(store.keys.agreement(l.id)) : null;
    if (!rec && l.key) {
      const linked = await jira.getIssue(client, l.key).catch(() => null);
      rec = await agreementFromIssue(client, linked);
    }
    if (!rec) continue;
    const kind = issue.labels.includes(LABELS.ESCALATION)
      ? 'escalation'
      : issue.labels.includes(LABELS.BLOCKER)
        ? 'blocker'
        : issue.labels.includes(LABELS.REVIEW)
          ? 'review'
          : 'linked';
    return { kind, agreement: evaluate(rec, today), baseUrl: base, disclaimer: DISCLAIMER };
  }
  return none;
}

// Board "link a page": write the remote link first, then KVS and the
// shared issue property. A failed link leaves storage unchanged.
export async function linkPageToAgreement(client, { issueId, pageRef }) {
  const pageId = jira.parsePageRef(pageRef);
  if (!pageId) return { ok: false, error: 'Paste a Confluence page URL or page id.' };
  const page = await jira.getPage(client, pageId);
  const a = (issueId ? await store.get(store.keys.agreement(issueId)) : null) || null;
  if (!a) return { ok: false, error: 'Agreement not found.' };
  const url = page.base && page.webui ? `${page.base}${page.webui}` : String(pageRef);
  await linkAgreementPage(client, a, pageId, url);
  return { ok: true };
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
  await healEscalationContractPages(client, board.agreements).catch(() => {});
  await saveSnapshot(accountId, board);
  return board;
}

async function computeBoard(client, { asUser }) {
  const today = todayIso();
  const [cfg, seed, lastRun, loaded, escRecords] = await Promise.all([
    store.get(store.keys.config),
    store.get(store.keys.seed),
    store.get(store.keys.lastRun),
    loadAgreements(client),
    loadEscalations(client),
  ]);
  const agreements = loaded.map((a) => evaluate(a, today));
  agreements.sort((a, b) => (a.invalid ? 1 : 0) - (b.invalid ? 1 : 0) || a.daysLeft - b.daysLeft);
  const byAgreement = new Map(agreements.map((a) => [String(a.issueId), a]));
  // Escalations found in Jira carry only ids: fill vendor and date from the agreement.
  const escalations = escRecords.map((e) => {
    const a = byAgreement.get(String(e.agreementId));
    const risk = a && !e.dateAtRisk ? dateAtRisk(a, today) : null;
    return { ...e, vendor: e.vendor || a?.vendor || null, agreementKey: e.agreementKey || a?.issueKey || null, dateAtRisk: e.dateAtRisk || risk?.date || null, riskKind: e.riskKind || risk?.kind || 'notice' };
  });
  const base = cfg?.baseUrl || (await siteBase(client).catch(() => ''));
  const visibleIds = new Set(agreements.map((a) => String(a.issueId)));
  // What this user can do in the Fides project, so the board can go
  // read-only instead of failing on a create. Unknown (null) on error.
  const permissionsP =
    asUser && cfg?.projectKey
      ? jira
          .myPermissions(client, cfg.projectKey, ['CREATE_ISSUES', 'BROWSE_PROJECTS', 'ADMINISTER'])
          .then((p) => ({ projectKey: cfg.projectKey, canCreate: p.CREATE_ISSUES, canBrowse: p.BROWSE_PROJECTS, isAdmin: p.ADMINISTER }))
          .catch(() => null)
      : Promise.resolve(null);
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
  const permissions = await permissionsP;
  return {
    today,
    baseUrl: base,
    config: cfg || null,
    seed: seed || null,
    permissions,
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

export async function previewImport(client, text) {
  return parseImport(text, await loadAgreements(client));
}

// Import rows [from, to) of a paste, through the same createAgreement path
// as the board's Add agreement form. Re-parses on the server; never trusts
// a client-side preview. Batches of 5 in parallel; each row reports
// created, skipped or failed.
export async function importAgreements(client, text, { from = 0, to = MAX_ROWS, batchSize = 5 } = {}) {
  const parsed = parseImport(text, await loadAgreements(client));
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

// Is this page already tracked? Jira-backed, in order:
//   1. by the page link: this install's pageAgreement record, the page id on
//      the issue property (or record), then the agreements' remote links
//      (globalId or URL). A page match wins even if the page dates differ.
//   2. by vendor + end date, the same rule as paste import.
async function agreementForPage(client, page, agreements, candidate = {}) {
  const pid = String(page.id);
  const onPage = (a) => String(a.confluencePageId || '') === pid || jira.parsePageRef(a.confluenceUrl) === pid;
  const rec = await store.get(store.keys.pageAgreement(pid)).catch(() => null);
  const byRecord = rec?.issueId ? agreements.find((a) => String(a.issueId) === String(rec.issueId)) : null;
  if (byRecord) return { agreement: byRecord, matchedBy: 'page' };
  const byId = agreements.find(onPage);
  if (byId) return { agreement: byId, matchedBy: 'page' };
  // Remote links: CLSD-35 style records whose property never learnt the page.
  const gid = jira.pageGlobalId(pid);
  const unlinked = agreements.filter((a) => !a.confluencePageId).slice(0, 100);
  const hits = await Promise.all(
    unlinked.map(async (a) => {
      const links = await jira.getRemoteLinks(client, a.issueKey).catch(() => []);
      return links.some((l) => l.globalId === gid || jira.parsePageRef(l.url) === pid) ? a : null;
    })
  );
  const byLink = hits.find(Boolean);
  if (byLink) return { agreement: byLink, matchedBy: 'page' };
  if (candidate.vendor && candidate.endDate) {
    const k = dupKey(candidate.vendor, candidate.endDate);
    const same = agreements.find((a) => dupKey(a.vendor, a.endDate) === k);
    if (same) return { agreement: same, matchedBy: 'vendor and end date' };
  }
  return null;
}

// Record the page on the agreement (this install's storage and the shared
// issue property), without creating anything.
async function adoptPage(client, agreement, page, url) {
  if (agreement.propertyPageId === String(page.id)) {
    await store.set(store.keys.pageAgreement(page.id), { issueId: agreement.issueId }).catch(() => {});
    return agreement;
  }
  return linkAgreementPage(client, agreement, String(page.id), agreement.confluenceUrl || url);
}

// An already-tracked page. Read-only unless confirmed: then the page link is
// written onto the issue and a lagging sample page is rewritten in place.
async function settleExisting(client, hit, page, pageInfo, url, extracted, confirm, writeClient = client) {
  const a = hit.agreement;
  const pageIsStale = Boolean(a.sample && String(page.id) === String(a.confluencePageId) && String(page.title || '').startsWith(SAMPLE_PAGE_PREFIX) && !pageMatchesRecord(page.storage, a));
  const result = existingResult(hit, page, pageInfo, extracted);
  result.pageStale = pageIsStale;
  if (!confirm) {
    if (pageIsStale) result.syncOffer = `This sample page still shows older dates than ${a.issueKey} in Jira. Ask the user whether to update the page to match Jira; if yes, call track-agreement-from-page with confirm true.`;
    return result;
  }
  await adoptPage(client, a, page, url).catch((e) => console.warn(`Fides ${a.issueKey}: could not record the page link: ${e.message}`));
  if (pageIsStale) {
    try {
      const r = await syncSamplePage(client, { ...a, confluencePageId: String(page.id) }, { force: true, writeClient });
      result.pageSynced = r;
      if (r === 'updated') result.message += ' The page dates were updated to match Jira.';
      console.log(`Fides page sync (rovo confirm): ${r} page ${page.id} for ${a.issueKey}`);
    } catch (e) {
      result.pageSynced = 'failed';
      // The write is made by the Fides app, not the user, so do not blame the
      // user's permissions; the agreement in Jira is the source of truth.
      result.message += ` Fides could not update the page dates (${e.status ? `HTTP ${e.status}` : e.message}). The agreement in Jira is correct and unchanged.`;
      console.warn(`Fides page sync (rovo confirm): ${e.stage === 'write' ? 'app write' : 'read'} failed for page ${page.id}: ${e.status ? `HTTP ${e.status} ` : ''}${e.message}`);
    }
  }
  return result;
}

function existingResult(m, page, pageInfo, extracted) {
  const a = m.agreement;
  const pageEnd = extracted?.endDate?.value || null;
  return {
    status: 'existing',
    page: pageInfo,
    matchedBy: m.matchedBy,
    agreement: { issueKey: a.issueKey, vendor: a.vendor, endDate: a.endDate, noticeDays: a.noticeDays },
    ...(pageEnd && pageEnd !== a.endDate ? { pageDiffers: `The page says the end date is ${pageEnd}; Fides tracks ${a.endDate} on ${a.issueKey} in Jira.` } : {}),
    message: `This page is already tracked as ${a.issueKey} ${a.vendor} (matched by ${m.matchedBy}). Nothing new was created.`,
  };
}

// Read a contract page as the user, propose structured fields with quoted
// sources, and create the agreement only when `confirm` is true. Dedupe is
// Jira-backed (see agreementForPage), so it gives the same answer from the
// Jira and the Confluence install.
//
// Writes happen only when `confirm` is true: with confirm false (the
// read-only check, or an unconfirmed call) nothing is created, adopted or
// rewritten. On confirm, an already-tracked sample page whose dates lag
// Jira is also brought in step, in place.
export async function trackAgreementFromPage(client, { pageRef, contextContentId = null, confirm = false, overrides = {}, writeClient = client } = {}) {
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

  const ex = extractAgreement({ title: page.title, storage: page.storage, text: storageToText(page.storage) });
  const proposal = { ...ex.fields };
  const merged = {
    vendor: overrides.vendor ?? proposal.vendor?.value ?? null,
    endDate: overrides.endDate ?? proposal.endDate?.value ?? null,
    noticeDays: overrides.noticeDays ?? proposal.noticeDays?.value ?? null,
    owner: overrides.owner ?? proposal.owner?.value ?? '',
    obligations: overrides.obligations ?? proposal.obligations.map((o) => o.value).join(' '),
  };

  let agreements = await loadAgreements(client);
  const hit = await agreementForPage(client, page, agreements, merged);
  if (hit) return settleExisting(client, hit, page, pageInfo, url, ex.fields, confirm, writeClient);

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
    // Re-check in Jira under the lock.
    agreements = await loadAgreements(client);
    const again = await agreementForPage(client, page, agreements, merged);
    if (again) return settleExisting(client, again, page, pageInfo, url, ex.fields, true, writeClient);
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
