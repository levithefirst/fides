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
  const issue = await jira.createIssue(client, {
    projectId: cfg.projectId,
    issueTypeId: cfg.issueTypeId,
    summary,
    description: agreementDescription(record),
    labels,
  });
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
  const issue = await jira.createIssue(client, {
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
  await store.set(store.keys.review(agreement.issueId), { issueKey: issue.key, at: new Date().toISOString() });
  return { created: true, issueKey: issue.key, url: browse(base, issue.key) };
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
      if (!issueKey) {
        const { blocker, risk } = plan;
        const issue = await jira.createIssue(client, {
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
        at: new Date().toISOString(),
      });
      existing.add(plan.key);
      out.created.push({ issueKey, url: browse(base, issueKey), blockerKey: plan.blocker.key, sentence: riskSentence(plan.risk) });
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

export async function boardData(client, { asUser }) {
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
          .map((e) => ({ issueKey: e.issueKey, url: browse(base, e.issueKey), blockerKey: e.blockerKey, dateAtRisk: e.dateAtRisk, riskKind: e.riskKind }));
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

export { upcomingNotices, DEFAULT_LOOKAHEAD_DAYS };
