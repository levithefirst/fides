// Live judge-mode acceptance check (scope addendum item 4).
//
// OFFICIAL CHECK (default): "open the board after install".
//   1. Install Fides on a fresh site (or after `forge uninstall`).
//   2. Run this script. When it says so, open Apps > Fides in Jira and press
//      Enter at the same moment.
//   3. It polls Jira until four sample agreements and exactly one escalation
//      issue exist. PASS if that happens within 10 s of the board opening.
//   It also reports whether each sample agreement has its Confluence
//   contract-page link (informational).
//
// INSTALL MODE (--install, best effort, never fails the run): start right
// after `forge install` returns; reports how long install-time seeding took.
// New installs wait for app permissions (observed ~45 s), and the install
// trigger retries with back-off, so this number is informational only.
//
//   JIRA_BASE_URL=https://<your-site>.atlassian.net \
//   ATLASSIAN_EMAIL=<account email> \
//   ATLASSIAN_API_TOKEN=<classic API token, from the environment only> \
//   node scripts/acceptance-live.mjs [--install]
//
// The token is read from the environment and never printed.

import readline from 'node:readline/promises';

const { JIRA_BASE_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN } = process.env;
const BUDGET_MS = Number(process.env.FIDES_BUDGET_MS || 10_000);
const INSTALL_MODE = process.argv.includes('--install');
if (!JIRA_BASE_URL || !ATLASSIAN_EMAIL || !ATLASSIAN_API_TOKEN) {
  console.error('Set JIRA_BASE_URL, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in the environment.');
  process.exit(2);
}
const base = JIRA_BASE_URL.replace(/\/$/, '');
const headers = {
  Authorization: 'Basic ' + Buffer.from(`${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}`).toString('base64'),
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

async function search(jql) {
  const res = await fetch(`${base}/rest/api/3/search/jql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jql, fields: ['summary'], maxResults: 20 }),
  });
  if (!res.ok) throw new Error(`Jira search failed: HTTP ${res.status}`);
  return (await res.json()).issues || [];
}

async function remoteLinks(key) {
  const res = await fetch(`${base}/rest/api/3/issue/${key}/remotelink`, { headers });
  return res.ok ? res.json() : [];
}

async function poll(limitMs) {
  const t0 = Date.now();
  let agreements = [];
  let escalations = [];
  while (Date.now() - t0 < limitMs) {
    [agreements, escalations] = await Promise.all([
      search('labels = "fides-agreement" AND labels = "fides-sample"'),
      search('labels = "fides-escalation"'),
    ]);
    if (agreements.length >= 4 && escalations.length >= 1) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { agreements, escalations, elapsed: Date.now() - t0 };
}

if (INSTALL_MODE) {
  console.log('Install mode (best effort): polling for up to 5 minutes...');
  const r = await poll(5 * 60_000);
  console.log(`agreements: ${r.agreements.length}, escalations: ${r.escalations.length}, after ${r.elapsed} ms`);
  console.log('INFO only: install-time seeding waits for app permissions. The official check is the default board-open mode.');
  process.exit(0);
}

const pre = await Promise.all([search('labels = "fides-sample"'), search('labels = "fides-escalation"')]);
if (pre[0].length || pre[1].length) {
  console.log(
    `Note: ${pre[0].length} sample issue(s) and ${pre[1].length} escalation(s) already exist (install-time seeding got there first, or this is not a fresh site). The timing below then measures only what is already visible.`
  );
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Open Apps > Fides in Jira now, and press Enter at the same moment... ');
rl.close();

const r = await poll(BUDGET_MS * 3);
console.log(`agreements: ${r.agreements.length}, escalations: ${r.escalations.length}, after ${r.elapsed} ms`);
for (const e of r.escalations) console.log(`  ${e.key}  ${e.fields.summary}`);

// Informational: contract-page links (gap 1). Present once Confluence is reachable.
const linked = await Promise.all(r.agreements.map(async (a) => ({ key: a.key, n: (await remoteLinks(a.key)).length })));
console.log(`Confluence page links: ${linked.filter((x) => x.n > 0).length}/${linked.length} agreements (${linked.map((x) => `${x.key}:${x.n}`).join(', ')})`);

if (r.escalations.length > 1) {
  console.log('FAIL: more than one escalation issue (idempotency broken)');
  process.exit(1);
}
if (r.agreements.length >= 4 && r.escalations.length === 1 && r.elapsed <= BUDGET_MS) {
  console.log(`PASS: seeded board and escalation visible ${r.elapsed} ms after opening the board (budget ${BUDGET_MS} ms)`);
  process.exit(0);
}
console.log(`FAIL: not visible within ${BUDGET_MS} ms of opening the board.`);
process.exit(1);
