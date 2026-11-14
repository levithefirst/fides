// Live acceptance poll for judge mode (scope addendum item 4, install path).
//
// Run right after `forge install` finishes on a FRESH site. It polls the
// site's Jira REST API until both the seeded agreements and the escalation
// issue exist, and fails if that takes longer than the budget.
//
//   JIRA_BASE_URL=https://<your-site>.atlassian.net \
//   ATLASSIAN_EMAIL=<account email> \
//   ATLASSIAN_API_TOKEN=<classic API token, from the environment only> \
//   node scripts/acceptance-live.mjs
//
// The token is read from the environment and never printed. The primary
// acceptance test is the manual board-open test in docs/HANDOFF.md; this
// script covers the install-trigger path, which can lag while Atlassian
// grants the app user its permissions.

const { JIRA_BASE_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN } = process.env;
const BUDGET_MS = Number(process.env.FIDES_BUDGET_MS || 10_000);
if (!JIRA_BASE_URL || !ATLASSIAN_EMAIL || !ATLASSIAN_API_TOKEN) {
  console.error('Set JIRA_BASE_URL, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in the environment.');
  process.exit(2);
}
const auth = 'Basic ' + Buffer.from(`${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}`).toString('base64');

async function count(jql) {
  const res = await fetch(`${JIRA_BASE_URL.replace(/\/$/, '')}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql, fields: ['summary'], maxResults: 20 }),
  });
  if (!res.ok) throw new Error(`Jira search failed: HTTP ${res.status}`);
  return (await res.json()).issues || [];
}

const t0 = Date.now();
let agreements = [];
let escalations = [];
while (Date.now() - t0 < BUDGET_MS * 3) {
  [agreements, escalations] = await Promise.all([
    count('labels = "fides-agreement" AND labels = "fides-sample"'),
    count('labels = "fides-escalation"'),
  ]);
  if (agreements.length >= 4 && escalations.length >= 1) break;
  await new Promise((r) => setTimeout(r, 500));
}
const elapsed = Date.now() - t0;
console.log(`agreements: ${agreements.length}, escalations: ${escalations.length}, after ${elapsed} ms`);
for (const e of escalations) console.log(`  ${e.key}  ${e.fields.summary}`);
if (agreements.length >= 4 && escalations.length === 1 && elapsed <= BUDGET_MS) {
  console.log(`PASS: seeded board and escalation visible in ${elapsed} ms (budget ${BUDGET_MS} ms)`);
  process.exit(0);
}
console.log(
  escalations.length > 1
    ? 'FAIL: more than one escalation issue (idempotency broken)'
    : `FAIL: not visible within ${BUDGET_MS} ms. Run the manual board-open test in docs/HANDOFF.md; the install trigger may be waiting on app permissions.`
);
process.exit(1);
