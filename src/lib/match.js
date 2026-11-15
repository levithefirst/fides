// Agreement resolution for Rovo actions. Names win over keys: the LLM may
// pass a guessed issue key, or the action may run on another issue's page
// (context issue key), so "Create a review issue for Northwind Analytics"
// must resolve by the name the user said, never by whatever key is nearby.
//
// Order:
//   1. exact vendor name, or exact issue summary
//   2. the input contains the vendor name, or the vendor name contains the input
//   3. fuzzy token match on vendor and summary (tolerates a small typo)
//   4. exact issue key or issue id typed by the user
//   5. only if no input at all: the context issue (the page Rovo was opened on)
// Ties at the fuzzy step are reported as ambiguous, never guessed.

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const STOP = new Set(['the', 'a', 'an', 'for', 'of', 'agreement', 'contract', 'vendor', 'sample', 'notice', 'by', 'ltd', 'inc', 'llc']);
const tokens = (s) => norm(s).split(' ').filter((t) => t.length > 1 && !STOP.has(t));

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

const tokenMatches = (q, t) => t === q || (q.length >= 4 && t.startsWith(q)) || (q.length >= 5 && editDistance(q, t) <= 1);

// Share of the query's tokens found in the candidate's vendor or summary.
function fuzzyScore(query, a) {
  const q = tokens(query);
  if (!q.length) return 0;
  const cand = [...new Set([...tokens(a.vendor), ...tokens(a.summary)])];
  const hits = q.filter((qt) => cand.some((t) => tokenMatches(qt, t))).length;
  return hits / q.length;
}

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/i;

export function matchAgreement(agreements, ref, contextIssueKey) {
  const raw = String(ref ?? '').trim();
  const n = norm(raw);
  const result = (agreement, matchedBy) => ({ agreement, matchedBy, candidates: [] });

  if (!raw) {
    if (!contextIssueKey) return { agreement: null, matchedBy: null, candidates: [] };
    const a = agreements.find((x) => x.issueKey?.toLowerCase() === String(contextIssueKey).toLowerCase());
    return a ? result(a, 'the issue Rovo was opened on') : { agreement: null, matchedBy: null, candidates: [] };
  }

  // 1. exact name or summary
  const exact = agreements.filter((a) => norm(a.vendor) === n || (a.summary && norm(a.summary) === n));
  if (exact.length === 1) return result(exact[0], 'exact name');

  // 2. containment. If several vendors are contained in the input, the
  //    longest one wins only when it is strictly the longest.
  if (n.length >= 3) {
    const contains = agreements
      .filter((a) => {
        const v = norm(a.vendor);
        return v && (n.includes(v) || v.includes(n));
      })
      .sort((x, y) => norm(y.vendor).length - norm(x.vendor).length);
    if (contains.length === 1) return result(contains[0], 'name');
    if (contains.length > 1) {
      const [first, second] = contains;
      if (n.includes(norm(first.vendor)) && norm(first.vendor).length > norm(second.vendor).length) return result(first, 'name');
      return { agreement: null, matchedBy: null, candidates: contains.slice(0, 5) };
    }
  }

  // 3. fuzzy tokens
  const scored = agreements.map((a) => ({ a, s: fuzzyScore(raw, a) })).filter((x) => x.s >= 0.5).sort((x, y) => y.s - x.s);
  if (scored.length) {
    const top = scored.filter((x) => x.s === scored[0].s);
    if (top.length === 1) return result(top[0].a, 'similar name');
    return { agreement: null, matchedBy: null, candidates: top.slice(0, 5).map((x) => x.a) };
  }

  // 4. an issue key or id the user typed
  const keyish = raw.match(/[A-Z][A-Z0-9_]+-\d+/i)?.[0];
  if (keyish && KEY.test(keyish)) {
    const a = agreements.find((x) => x.issueKey?.toLowerCase() === keyish.toLowerCase());
    if (a) return result(a, 'issue key');
  }
  const byId = agreements.find((x) => String(x.issueId) === raw);
  if (byId) return result(byId, 'issue id');

  return { agreement: null, matchedBy: null, candidates: [] };
}

// One line the agent repeats so the user can check the key before trusting it.
export function confirmation(ref, m) {
  if (!m.agreement) return null;
  const said = String(ref ?? '').trim();
  return `Resolved ${said ? `"${said}"` : 'this request'} to ${m.agreement.issueKey} ${m.agreement.vendor} (matched by ${m.matchedBy}).`;
}
