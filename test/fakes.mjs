// In-memory fakes for Jira Cloud REST v3, Confluence REST v2 and the Forge
// Key-Value Store, with configurable latency per call. Used only by the
// offline judge-mode acceptance test; never bundled into the app.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fakeKvs() {
  const data = new Map();
  const kvs = {
    data,
    async get(k) {
      return data.has(k) ? structuredClone(data.get(k)) : undefined;
    },
    async set(k, v, opts) {
      if (opts?.keyPolicy === 'FAIL_IF_EXISTS' && data.has(k)) {
        const e = new Error('KEY_ALREADY_EXISTS');
        e.code = 'KEY_ALREADY_EXISTS';
        throw e;
      }
      data.set(k, structuredClone(v));
    },
    async delete(k) {
      data.delete(k);
    },
    query() {
      let prefix = '';
      const q = {
        where: (_f, cond) => ((prefix = cond.prefix), q),
        limit: () => q,
        cursor: () => q,
        getMany: async () => ({
          results: [...data.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })),
        }),
      };
      return q;
    },
  };
  return { kvs, WhereConditions: { beginsWith: (prefix) => ({ prefix }) } };
}

function matchesJql(issue, jql) {
  return jql.split(/\s+AND\s+/i).every((clause) => {
    let m;
    if ((m = /^key in \(([^)]*)\)$/i.exec(clause.trim()))) {
      return m[1].split(',').map((s) => s.trim()).includes(issue.key);
    }
    if ((m = /^labels\s*=\s*"([^"]+)"$/i.exec(clause.trim()))) return issue.labels.includes(m[1]);
    if ((m = /^labels\s*!=\s*"([^"]+)"$/i.exec(clause.trim()))) return !issue.labels.includes(m[1]);
    throw new Error(`fake JQL cannot parse: ${clause}`);
  });
}

export function fakeSite({ latencyMs = 0, extraLatency = null, confluence = true, projects = [{ id: '10000', key: 'OPS', name: 'Operations' }] } = {}) {
  const issues = new Map(); // key -> issue
  const pages = new Map();
  const calls = [];
  let nextIssue = 10001;
  let nextPage = 900001;
  const base = 'https://example-site.atlassian.net';
  // Toggles for clean-site permission states.
  const state = {
    confluence,
    canCreate: true,
    createmetaEmpty: false,
    canBrowse: true,
    failCreateFor: null,
    // Users and assignment. userSearch false = the app lacks read:jira-user (the live situation).
    users: [
      { accountId: '5b10a2844c20165700ede21g', displayName: 'Dana Whitfield', emailAddress: 'dana@example.com' },
      { accountId: '5b10ac8d82e05b22cc7d4ef5', displayName: 'Sam Okafor', emailAddress: 'sam@example.com' },
    ],
    userSearch: false,
    unassignable: new Set(),
    defaultAssignee: null,
    isAdmin: true,
  };

  const json = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    statusText: String(status),
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });
  const view = (i) => ({
    id: i.id,
    key: i.key,
    fields: {
      summary: i.summary,
      labels: i.labels,
      status: { name: i.status, statusCategory: { key: i.statusCategory } },
      assignee: i.assignee ? { accountId: i.assignee } : null,
      description: i.description || null,
      project: { id: i.projectId, key: i.projectKey },
      issuelinks: i.links.map((k) => ({ type: { name: 'Blocks' }, outwardIssue: { id: issues.get(k).id, key: k } })),
    },
  });

  async function handle(product, path, opts = {}) {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push(`${method} ${path.value ?? path}`);
    await sleep(latencyMs + (extraLatency ? extraLatency(product, method, String(path.value ?? path), body) : 0));
    const p = String(path.value ?? path);
    let m;
    if (product === 'jira') {
      if (p === '/rest/api/3/serverInfo') return json(200, { baseUrl: base });
      if (p.startsWith('/rest/api/3/project/search')) return json(200, { values: projects });
      if (/^\/rest\/api\/3\/issue\/createmeta\//.test(p) && state.createmetaEmpty) return json(200, { issueTypes: [] });
      if ((m = /^\/rest\/api\/3\/issue\/createmeta\/([^/]+)\/issuetypes/.exec(p)))
        return json(200, { issueTypes: [{ id: '3', name: 'Epic', hierarchyLevel: 1 }, { id: '1', name: 'Task', hierarchyLevel: 0, subtask: false }] });
      if (p === '/rest/api/3/issue' && method === 'POST' && !state.canCreate)
        return json(400, { errors: { project: 'You do not have permission to create issues in this project.' } });
      if (p === '/rest/api/3/issue' && method === 'POST' && state.failCreateFor && state.failCreateFor.test(body.fields.summary))
        return json(500, { errorMessages: ['Internal server error'] });
      if (p === '/rest/api/3/issue' && method === 'POST') {
        const id = String(nextIssue++);
        const proj = projects.find((x) => x.id === body.fields.project.id);
        const key = `${proj.key}-${id.slice(-3).replace(/^0+/, '')}`;
        const want = body.fields.assignee?.id || null;
        if (want && (state.unassignable.has(want) || !state.users.some((u) => u.accountId === want)))
          return json(400, { errorMessages: [], errors: { assignee: `User '${want}' cannot be assigned issues.` } });
        issues.set(key, { id, key, description: body.fields.description || null, properties: {}, summary: body.fields.summary, labels: body.fields.labels || [], status: 'To Do', statusCategory: 'new', projectId: proj.id, projectKey: proj.key, links: [], remote: [], comments: [], watchers: [], assignee: want || state.defaultAssignee });
        return json(201, { id, key });
      }
      if (p === '/rest/api/3/search/jql') {
        const jql = body.jql.replace(/\s+ORDER BY\s+created\s+ASC\s*$/i, '');
        const found = [...issues.values()]
          .filter((i) => matchesJql(i, jql))
          .sort((x, y) => Number(x.id) - Number(y.id))
          .slice(0, body.maxResults || 50);
        return json(200, {
          issues: found.map((i) => ({
            ...view(i),
            ...(body.properties?.length ? { properties: Object.fromEntries(body.properties.filter((k) => i.properties?.[k]).map((k) => [k, i.properties[k]])) } : {}),
          })),
          isLast: true,
        });
      }
      if (p === '/rest/api/3/issue/bulkfetch' && !state.canBrowse) return json(403, { errorMessages: ['Forbidden'] });
      if (p === '/rest/api/3/issue/bulkfetch') {
        const want = new Set(body.issueIdsOrKeys);
        const found = [...issues.values()].filter((i) => want.has(i.id) || want.has(i.key));
        return json(200, { issues: found.map(view), issueErrors: [] });
      }
      if (p === '/rest/api/3/issueLinkType') return json(200, { issueLinkTypes: [{ name: 'Blocks' }, { name: 'Relates' }] });
      if (p === '/rest/api/3/issueLink') {
        const a = issues.get(body.inwardIssue.key);
        const b = issues.get(body.outwardIssue.key);
        a.links.push(b.key);
        b.links.push(a.key);
        return json(201);
      }
      if ((m = /^\/rest\/api\/3\/issue\/([^/?]+)\/remotelink$/.exec(p))) {
        // Jira upserts when the globalId already exists on the issue.
        const remote = issues.get(m[1]).remote;
        const i = body.globalId ? remote.findIndex((r) => r.globalId === body.globalId) : -1;
        const entry = { ...body.object, globalId: body.globalId };
        if (i >= 0) remote[i] = entry;
        else remote.push(entry);
        return json(201, { id: 1 });
      }
      if ((m = /^\/rest\/api\/3\/issue\/([^/?]+)\/properties\/([^/?]+)$/.exec(p)) && method === 'PUT') {
        const i = issues.get(m[1]);
        if (!i) return json(404, { errorMessages: ['Issue does not exist'] });
        i.properties = { ...(i.properties || {}), [m[2]]: body };
        return json(200, {});
      }
      if ((m = /^\/rest\/api\/3\/issue\/([^/?]+)$/.exec(p)) && method === 'DELETE') {
        issues.delete(m[1]);
        return json(204);
      }
      if ((m = /^\/rest\/api\/3\/issue\/([^/?]+)\/watchers$/.exec(p)) && method === 'POST') {
        if (!state.users.some((u) => u.accountId === body)) return json(404, { errorMessages: ['User not found'] });
        issues.get(m[1]).watchers.push(body);
        return json(204);
      }
      if (p.startsWith('/rest/api/3/mypermissions')) {
        const can = { CREATE_ISSUES: state.canCreate && !state.createmetaEmpty, BROWSE_PROJECTS: state.canBrowse, ADMINISTER: state.isAdmin };
        const keys = decodeURIComponent(/permissions=([^&]+)/.exec(p)[1]).split(',');
        return json(200, { permissions: Object.fromEntries(keys.map((k) => [k, { key: k, havePermission: !!can[k] }])) });
      }
      if (p.startsWith('/rest/api/3/user/search')) {
        if (!state.userSearch) return json(403, { message: 'Unauthorized; scope does not match' });
        const q = decodeURIComponent(/query=([^&]+)/.exec(p)[1]).toLowerCase();
        return json(200, state.users.filter((u) => u.displayName.toLowerCase().includes(q) || u.emailAddress.toLowerCase() === q).map((u) => ({ ...u, accountType: 'atlassian', active: true })));
      }
      if ((m = /^\/rest\/api\/3\/issue\/([^/?]+)\/comment$/.exec(p))) {
        issues.get(m[1]).comments.push(body.body);
        return json(201, { id: 1 });
      }
      if ((m = /^\/rest\/api\/3\/issue\/([^/?]+)\?/.exec(p))) {
        const i = issues.get(m[1]) || [...issues.values()].find((x) => x.id === m[1]);
        return i ? json(200, view(i)) : json(404, { errorMessages: ['not found'] });
      }
    }
    if (product === 'confluence') {
      if (!state.confluence) return json(403, { message: 'Confluence not available' });
      if (p.startsWith('/wiki/api/v2/spaces')) return json(200, { results: [{ id: '777', key: 'LEGAL', type: 'global' }] });
      if (p.startsWith('/wiki/api/v2/pages?')) {
        const title = decodeURIComponent(/title=([^&]+)/.exec(p)[1]);
        const space = /space-id=([^&]+)/.exec(p)?.[1];
        const found = [...pages.values()].filter((x) => x.title === title && (!space || x.spaceId === space));
        return json(200, {
          results: found.map((x) => ({ id: x.id, title: x.title, _links: { webui: `/spaces/${x.spaceKey}/pages/${x.id}` } })),
          _links: { base: `${base}/wiki` },
        });
      }
      if (p === '/wiki/api/v2/pages' && method === 'POST') {
        const id = String(nextPage++);
        pages.set(id, { id, title: body.title, storage: body.body.value, spaceId: body.spaceId, spaceKey: 'LEGAL' });
        return json(200, { id, _links: { webui: `/spaces/LEGAL/pages/${id}`, base: `${base}/wiki` } });
      }
      if ((m = /^\/wiki\/api\/v2\/pages\/(\d+)\?/.exec(p))) {
        const pg = pages.get(m[1]);
        return pg ? json(200, { id: pg.id, title: pg.title, body: { storage: { value: pg.storage } }, _links: { webui: `/spaces/${pg.spaceKey || "LEGAL"}/pages/${pg.id}`, base: `${base}/wiki` } }) : json(404, {});
      }
    }
    throw new Error(`fake site: unhandled ${product} ${method} ${p}`);
  }

  // Simulate a page created outside this app run (e.g. by a later
  // Confluence install) in another space.
  const addPage = ({ title, storage = '<p>x</p>', spaceId = '888', spaceKey = 'EO' }) => {
    const id = String(nextPage++);
    pages.set(id, { id, title, storage, spaceId, spaceKey });
    return id;
  };

  const client = {
    requestJira: (path, opts) => handle('jira', path, opts),
    requestConfluence: (path, opts) => handle('confluence', path, opts),
  };
  return { client, issues, pages, calls, base, state, addPage };
}
