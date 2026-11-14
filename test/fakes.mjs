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

export function fakeSite({ latencyMs = 0, confluence = true, projects = [{ id: '10000', key: 'OPS', name: 'Operations' }] } = {}) {
  const issues = new Map(); // key -> issue
  const pages = new Map();
  const calls = [];
  let nextIssue = 10001;
  let nextPage = 900001;
  const base = 'https://example-site.atlassian.net';

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
      project: { id: i.projectId, key: i.projectKey },
      issuelinks: i.links.map((k) => ({ type: { name: 'Blocks' }, outwardIssue: { id: issues.get(k).id, key: k } })),
    },
  });

  async function handle(product, path, opts = {}) {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push(`${method} ${path}`);
    await sleep(latencyMs);
    const p = String(path.value ?? path);
    let m;
    if (product === 'jira') {
      if (p === '/rest/api/3/serverInfo') return json(200, { baseUrl: base });
      if (p.startsWith('/rest/api/3/project/search')) return json(200, { values: projects });
      if ((m = /^\/rest\/api\/3\/issue\/createmeta\/([^/]+)\/issuetypes/.exec(p)))
        return json(200, { issueTypes: [{ id: '3', name: 'Epic', hierarchyLevel: 1 }, { id: '1', name: 'Task', hierarchyLevel: 0, subtask: false }] });
      if (p === '/rest/api/3/issue' && method === 'POST') {
        const id = String(nextIssue++);
        const proj = projects.find((x) => x.id === body.fields.project.id);
        const key = `${proj.key}-${id.slice(-3).replace(/^0+/, '')}`;
        issues.set(key, { id, key, summary: body.fields.summary, labels: body.fields.labels || [], status: 'To Do', statusCategory: 'new', projectId: proj.id, projectKey: proj.key, links: [], remote: [], comments: [] });
        return json(201, { id, key });
      }
      if (p === '/rest/api/3/search/jql') {
        const found = [...issues.values()].filter((i) => matchesJql(i, body.jql)).slice(0, body.maxResults || 50);
        return json(200, { issues: found.map(view), isLast: true });
      }
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
        issues.get(m[1]).remote.push(body.object);
        return json(201, { id: 1 });
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
      if (!confluence) return json(403, { message: 'Confluence not available' });
      if (p.startsWith('/wiki/api/v2/spaces')) return json(200, { results: [{ id: '777', key: 'LEGAL', type: 'global' }] });
      if (p.startsWith('/wiki/api/v2/pages?')) {
        const title = decodeURIComponent(/title=([^&]+)/.exec(p)[1]);
        const found = [...pages.values()].filter((x) => x.title === title);
        return json(200, { results: found.map((x) => ({ id: x.id, _links: { webui: `/spaces/LEGAL/pages/${x.id}` } })) });
      }
      if (p === '/wiki/api/v2/pages' && method === 'POST') {
        const id = String(nextPage++);
        pages.set(id, { id, title: body.title, storage: body.body.value });
        return json(200, { id, _links: { webui: `/spaces/LEGAL/pages/${id}`, base: `${base}/wiki` } });
      }
      if ((m = /^\/wiki\/api\/v2\/pages\/(\d+)\?/.exec(p))) {
        const pg = pages.get(m[1]);
        return pg ? json(200, { id: pg.id, title: pg.title, body: { storage: { value: pg.storage } }, _links: { webui: `/x/${pg.id}`, base: `${base}/wiki` } }) : json(404, {});
      }
    }
    throw new Error(`fake site: unhandled ${product} ${method} ${p}`);
  }

  const client = {
    requestJira: (path, opts) => handle('jira', path, opts),
    requestConfluence: (path, opts) => handle('confluence', path, opts),
  };
  return { client, issues, pages, calls, base };
}
