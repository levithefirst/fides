// Thin wrappers over documented Jira Cloud REST v3 and Confluence Cloud
// REST v2 endpoints. Every function takes a `client`, which is either
// api.asUser() (UI resolvers and Rovo actions, permission-aware) or
// api.asApp() (scheduled trigger and install trigger, which have no user).
// Paths are recorded in docs/SDK-NOTES.md.

import { route } from '@forge/api';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
  get forbidden() {
    return this.status === 401 || this.status === 403;
  }
  get notFound() {
    return this.status === 404;
  }
  // Jira reports "no permission to create" as 401/403, or as a 400 whose
  // message mentions permission; createmeta with no creatable types is
  // flagged as `noCreate` by pickIssueType.
  get permissionDenied() {
    return this.forbidden || this.noCreate === true || (this.status === 400 && /permission/i.test(this.message));
  }
}

async function call(client, product, path, { method = 'GET', body } = {}) {
  const fn = product === 'confluence' ? client.requestConfluence : client.requestJira;
  const res = await fn.call(client, path, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.errorMessages?.join('; ') || json?.message || JSON.stringify(json?.errors || json) || res.statusText;
    throw new ApiError(`${method} ${product} ${res.status}: ${msg}`, res.status, json);
  }
  return json;
}

// ---------- ADF helpers (Jira descriptions and comments) ----------

export const adf = {
  doc: (...content) => ({ type: 'doc', version: 1, content }),
  p: (...parts) => ({
    type: 'paragraph',
    content: parts.map((x) => (typeof x === 'string' ? { type: 'text', text: x } : x)),
  }),
  text: (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) }),
  link: (text, href) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }),
  strong: (text) => ({ type: 'text', text, marks: [{ type: 'strong' }] }),
  em: (text) => ({ type: 'text', text, marks: [{ type: 'em' }] }),
};

// ---------- Jira ----------

export async function getServerInfo(client) {
  return call(client, 'jira', route`/rest/api/3/serverInfo`);
}

export async function listProjects(client) {
  const res = await call(client, 'jira', route`/rest/api/3/project/search?maxResults=50&orderBy=name`);
  return (res?.values || []).map((p) => ({ id: p.id, key: p.key, name: p.name }));
}

// Pick a standard (non-subtask, base level) issue type: Task if present,
// otherwise the first standard type. No custom issue type is required.
export async function pickIssueType(client, projectKey) {
  const res = await call(client, 'jira', route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes?maxResults=50`);
  const types = res?.issueTypes || res?.values || [];
  const standard = types.filter((t) => !t.subtask && (t.hierarchyLevel === undefined || t.hierarchyLevel === 0));
  const task = standard.find((t) => String(t.name).toLowerCase() === 'task');
  const chosen = task || standard[0];
  if (!chosen) {
    // createmeta only lists types the caller can create: empty means no
    // Create issues permission in this project.
    const e = new ApiError(`You cannot create issues in ${projectKey}`, 403, null);
    e.noCreate = true;
    throw e;
  }
  return { id: chosen.id, name: chosen.name };
}

// With `assigneeAccountId`, Jira assigns on create (and sends its own
// assignment notification). If Jira rejects the assignee (not assignable in
// the project, deactivated user), the issue is created unassigned and the
// returned `warning` says why; the create itself never fails on it.
export async function createIssue(client, { projectId, issueTypeId, summary, description, labels, assigneeAccountId = null }) {
  const fields = {
    project: { id: String(projectId) },
    issuetype: { id: String(issueTypeId) },
    summary: summary.slice(0, 250),
    ...(description ? { description } : {}),
    labels,
  };
  const post = (f) => call(client, 'jira', route`/rest/api/3/issue`, { method: 'POST', body: { fields: f } });
  if (!assigneeAccountId) {
    const res = await post(fields);
    return { id: res.id, key: res.key, assigned: false };
  }
  try {
    const res = await post({ ...fields, assignee: { id: String(assigneeAccountId) } });
    return { id: res.id, key: res.key, assigned: true };
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 400 || !/assignee/i.test(e.message)) throw e;
    const res = await post(fields);
    return { id: res.id, key: res.key, assigned: false, warning: `Could not assign to the owner: ${e.message}` };
  }
}

// What the caller may do (read:jira-work). Returns { KEY: boolean }.
export async function myPermissions(client, projectKey, keys) {
  const res = await call(client, 'jira', route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=${keys.join(',')}`);
  const out = {};
  for (const k of keys) out[k] = res?.permissions?.[k]?.havePermission === true;
  return out;
}

export async function addWatcher(client, issueKey, accountId) {
  // The body is the account id as a JSON string.
  await call(client, 'jira', route`/rest/api/3/issue/${issueKey}/watchers`, { method: 'POST', body: String(accountId) });
}

// Needs the read:jira-user scope, which Fides does not request. Callers
// treat 401/403 as "user search unavailable" and fall back.
export async function searchUsers(client, query) {
  const res = await call(client, 'jira', route`/rest/api/3/user/search?query=${query}&maxResults=10`);
  return (res || []).map((u) => ({ accountId: u.accountId, displayName: u.displayName, emailAddress: u.emailAddress, accountType: u.accountType, active: u.active }));
}

export async function getIssue(client, issueIdOrKey) {
  const res = await call(
    client,
    'jira',
    route`/rest/api/3/issue/${issueIdOrKey}?fields=summary,status,labels,issuelinks,project,issuetype,assignee`
  );
  return normaliseIssue(res);
}

export function normaliseIssue(i) {
  return {
    id: i.id,
    key: i.key,
    summary: i.fields?.summary,
    labels: i.fields?.labels || [],
    statusName: i.fields?.status?.name,
    statusCategory: i.fields?.status?.statusCategory?.key,
    projectKey: i.fields?.project?.key,
    projectId: i.fields?.project?.id,
    assigneeAccountId: i.fields?.assignee?.accountId || null,
    links: (i.fields?.issuelinks || []).map((l) => {
      const other = l.inwardIssue || l.outwardIssue;
      return { linkType: l.type?.name, id: other?.id, key: other?.key };
    }),
  };
}

export async function searchIssues(client, jql, fields = ['summary', 'status', 'labels'], maxResults = 100) {
  const res = await call(client, 'jira', route`/rest/api/3/search/jql`, {
    method: 'POST',
    body: { jql, fields, maxResults },
  });
  return (res?.issues || []).map(normaliseIssue);
}

// Permission-aware fetch of up to 100 issues by id or key. Deleted or
// hidden issues are simply absent (reported in issueErrors), unlike JQL
// `key in (...)` which fails the whole query on one bad key.
export async function bulkFetch(client, idsOrKeys, fields = ['summary', 'status', 'labels']) {
  if (!idsOrKeys.length) return [];
  const res = await call(client, 'jira', route`/rest/api/3/issue/bulkfetch`, {
    method: 'POST',
    body: { issueIdsOrKeys: idsOrKeys.slice(0, 100).map(String), fields },
  });
  return (res?.issues || []).map(normaliseIssue);
}

let linkTypeCache = null;
export async function linkTypeNames(client) {
  if (linkTypeCache) return linkTypeCache;
  const res = await call(client, 'jira', route`/rest/api/3/issueLinkType`);
  const names = (res?.issueLinkTypes || []).map((t) => t.name);
  const pick = (want) => names.find((n) => n.toLowerCase() === want) || null;
  linkTypeCache = {
    blocks: pick('blocks') || pick('relates') || names[0],
    relates: pick('relates') || names[0],
  };
  return linkTypeCache;
}

// Link two issues. Fides never relies on link direction: blockers are found
// by the `fides-blocker` label on any linked issue.
export async function linkIssues(client, typeName, fromKey, toKey) {
  await call(client, 'jira', route`/rest/api/3/issueLink`, {
    method: 'POST',
    body: { type: { name: typeName }, inwardIssue: { key: toKey }, outwardIssue: { key: fromKey } },
  });
}

// With a `globalId`, Jira updates the existing remote link instead of adding
// a second one, so repeated calls are idempotent.
export async function addRemoteLink(client, issueKey, url, title, globalId) {
  await call(client, 'jira', route`/rest/api/3/issue/${issueKey}/remotelink`, {
    method: 'POST',
    body: { ...(globalId ? { globalId } : {}), object: { url, title: title.slice(0, 250) } },
  });
}

export const pageGlobalId = (pageId) => `fides-confluence-page-${pageId}`;

export async function addComment(client, issueKey, body) {
  await call(client, 'jira', route`/rest/api/3/issue/${issueKey}/comment`, { method: 'POST', body: { body } });
}

// ---------- Confluence ----------

export async function getPage(client, pageId) {
  const res = await call(client, 'confluence', route`/wiki/api/v2/pages/${pageId}?body-format=storage`);
  return {
    id: res.id,
    title: res.title,
    storage: res.body?.storage?.value || '',
    webui: res._links?.webui,
    base: res._links?.base,
  };
}

// Exact-title lookup. Without a space id it searches every space the caller
// can see (the sample pages may live in any space, for example one created
// by a later Confluence install).
export async function findPageByTitle(client, spaceId, title) {
  const res = spaceId
    ? await call(client, 'confluence', route`/wiki/api/v2/pages?space-id=${spaceId}&title=${title}&status=current&limit=5`)
    : await call(client, 'confluence', route`/wiki/api/v2/pages?title=${title}&status=current&limit=5`);
  const p = (res?.results || []).find((r) => r.title === undefined || r.title === title);
  return p ? { id: p.id, webui: p._links?.webui, base: res?._links?.base } : null;
}

export async function pickSpace(client) {
  const res = await call(client, 'confluence', route`/wiki/api/v2/spaces?limit=25&status=current`);
  const spaces = res?.results || [];
  return spaces.find((s) => s.type !== 'personal') || spaces[0] || null;
}

export async function createPage(client, { spaceId, title, storage }) {
  const res = await call(client, 'confluence', route`/wiki/api/v2/pages`, {
    method: 'POST',
    body: { spaceId: String(spaceId), status: 'current', title, body: { representation: 'storage', value: storage } },
  });
  return { id: res.id, webui: res._links?.webui, base: res._links?.base };
}

// Accept a numeric page id or a Confluence page URL (".../pages/12345/...").
export function parsePageRef(ref) {
  if (!ref) return null;
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) return s;
  const m = /\/pages\/(\d+)/.exec(s) || /[?&]pageId=(\d+)/.exec(s);
  return m ? m[1] : null;
}
