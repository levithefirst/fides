// Reset Fides sample data on one site.
//
// Lists every issue Fides judge-mode seeding created (sample agreements,
// blockers, review issues and escalations: all carry the `fides-sample`
// label, agreements also `fides-sample-<key>`). Changes nothing unless
// --apply is passed. Never touches an issue without a fides-sample label.
//
//   FORGE_EMAIL=<account email> FORGE_API_TOKEN=<token, from the environment only> \
//   node scripts/reset-samples.mjs --site https://<site>.atlassian.net [--apply]
//
// The token must be allowed to call the Jira REST API for that site (a
// classic API token, or a scoped token that includes Jira work read and
// write). It is read from the environment and never printed.
//
// After --apply, open the Fides board and click Load samples (or reinstall
// Fides) to seed one fresh set.

import { fileURLToPath } from 'node:url';

export const SAMPLE_KEYS = ['helios', 'larkspur', 'northwind', 'quay'];
export const SAMPLE_LABELS = ['fides-sample', ...SAMPLE_KEYS.map((k) => `fides-sample-${k}`), ...SAMPLE_KEYS.map((k) => `fides-sample-${k}-blocker`)];

export const isSampleIssue = (labels = []) => labels.some((l) => l === 'fides-sample' || /^fides-sample-[a-z0-9-]+$/.test(l));

export function kindOf(labels = []) {
  if (labels.includes('fides-escalation')) return 'escalation';
  if (labels.includes('fides-review')) return 'review';
  if (labels.includes('fides-blocker')) return 'blocker';
  if (labels.includes('fides-agreement')) return 'agreement';
  return 'other sample';
}

// Pure: from search results to the exact delete plan (sample issues only).
export function plan(issues) {
  const order = { escalation: 0, review: 1, blocker: 2, agreement: 3, 'other sample': 4 };
  return issues
    .filter((i) => isSampleIssue(i.fields?.labels))
    .map((i) => ({ key: i.key, kind: kindOf(i.fields.labels), summary: i.fields.summary || '', labels: i.fields.labels }))
    .sort((a, b) => order[a.kind] - order[b.kind] || a.key.localeCompare(b.key, undefined, { numeric: true }));
}

function args(argv) {
  const out = { apply: false, site: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--site') out.site = argv[++i];
    else if (argv[i].startsWith('--site=')) out.site = argv[i].slice(7);
  }
  return out;
}

async function main() {
  const { apply, site } = args(process.argv.slice(2));
  const { FORGE_EMAIL, FORGE_API_TOKEN } = process.env;
  const localTest = process.env.FIDES_RESET_TEST === '1' && /^http:\/\/127\.0\.0\.1:\d+$/.test(String(site));
  if (!site || !(localTest || /^https:\/\/[^/]+$/.test(site.replace(/\/$/, '')))) {
    console.error('Usage: node scripts/reset-samples.mjs --site https://<site>.atlassian.net [--apply]');
    process.exit(2);
  }
  if (!FORGE_EMAIL || !FORGE_API_TOKEN) {
    console.error('Set FORGE_EMAIL and FORGE_API_TOKEN in the environment.');
    process.exit(2);
  }
  const base = site.replace(/\/$/, '');
  const headers = {
    Authorization: 'Basic ' + Buffer.from(`${FORGE_EMAIL}:${FORGE_API_TOKEN}`).toString('base64'),
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  const jql = `labels in (${SAMPLE_LABELS.map((l) => `"${l}"`).join(', ')}) ORDER BY created ASC`;
  const issues = [];
  let nextPageToken;
  do {
    const res = await fetch(`${base}/rest/api/3/search/jql`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jql, fields: ['summary', 'labels'], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }),
    });
    if (!res.ok) {
      console.error(`Jira search failed: HTTP ${res.status}. Check the site URL and that the token can call the Jira REST API.`);
      process.exit(1);
    }
    const body = await res.json();
    issues.push(...(body.issues || []));
    nextPageToken = body.isLast === false ? body.nextPageToken : undefined;
  } while (nextPageToken);

  const todo = plan(issues);
  if (!todo.length) {
    console.log('No Fides sample issues found. Nothing to do.');
    return;
  }
  console.log(`${apply ? 'Deleting' : 'Would delete'} ${todo.length} Fides sample issue(s) on ${base}:`);
  for (const t of todo) console.log(`  ${t.key.padEnd(12)} ${t.kind.padEnd(11)} ${t.summary}`);
  const byKind = todo.reduce((m, t) => ((m[t.kind] = (m[t.kind] || 0) + 1), m), {});
  console.log(`Totals: ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  if (!apply) {
    console.log('Dry run: nothing was changed. Re-run with --apply to delete exactly these issues.');
    return;
  }
  let failed = 0;
  for (const t of todo) {
    const res = await fetch(`${base}/rest/api/3/issue/${encodeURIComponent(t.key)}?deleteSubtasks=false`, { method: 'DELETE', headers });
    if (res.status === 204 || res.status === 404) console.log(`  deleted ${t.key}`);
    else {
      failed += 1;
      console.log(`  FAILED  ${t.key}: HTTP ${res.status}`);
    }
  }
  console.log(failed ? `${failed} issue(s) could not be deleted.` : 'Done. Open the Fides board and click Load samples to seed one fresh set.');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
