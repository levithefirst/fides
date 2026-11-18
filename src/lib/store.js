// Key-Value Store layout (@forge/kvs, scope storage:app). The agreement
// issues themselves live in Jira; KVS holds the structured dates and
// obligations keyed by issue id, plus app state.
//
//   agreement:<issueId>      agreement record
//   config                   { projectId, projectKey, issueTypeId, issueTypeName }
//   seed                     judge-mode state { state, at, reason, version }
//   lock:seed                short-lived seeding lock (FAIL_IF_EXISTS + ttl)
//   lastRun                  last scheduled / manual scan stamp
//   esc:<agreementId>:<blockerId>   escalation claim { issueKey, at }
//   review:<agreementId>     { issueKey, pingedFor }
//   sample:<sampleKey>       { issueId } so seeding never duplicates
//   samplePage:<sampleKey>   { id, url } the sample's Confluence page
//   lock:page:<sampleKey>    short-lived page-creation lock
//   pageAgreement:<pageId>   { issueId } agreement tracked from that page
//   lock:track:<pageId>      short-lived track-from-page lock

import { kvs, WhereConditions } from '@forge/kvs';

export const keys = {
  agreement: (id) => `agreement:${id}`,
  review: (id) => `review:${id}`,
  sample: (k) => `sample:${k}`,
  samplePage: (k) => `samplePage:${k}`,
  pageLock: (k) => `lock:page:${k}`,
  pageAgreement: (id) => `pageAgreement:${id}`,
  trackLock: (id) => `lock:track:${id}`,
  config: 'config',
  seed: 'seed',
  seedLock: 'lock:seed',
  lastRun: 'lastRun',
};

export const get = (k) => kvs.get(k);
export const set = (k, v) => kvs.set(k, v);
export const del = (k) => kvs.delete(k);

// Returns true if this caller won the key, false if it already existed.
export async function claim(key, value, ttlSeconds) {
  try {
    await kvs.set(key, value, {
      keyPolicy: 'FAIL_IF_EXISTS',
      ...(ttlSeconds ? { ttl: { value: ttlSeconds, unit: 'SECONDS' } } : {}),
    });
    return true;
  } catch (e) {
    const already = await kvs.get(key).catch(() => undefined);
    if (already !== undefined) return false;
    throw e;
  }
}

async function listByPrefix(prefix) {
  const out = [];
  let cursor;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    out.push(...page.results.map((r) => r.value));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

export const listAgreements = () => listByPrefix('agreement:');

export async function listEscalationKeys() {
  const out = new Set();
  let cursor;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith('esc:')).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    page.results.forEach((r) => out.add(r.key));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

export async function saveAgreement(a) {
  await kvs.set(keys.agreement(a.issueId), a);
  return a;
}
