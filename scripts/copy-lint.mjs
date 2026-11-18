// Copy lint for Fides. Checks UI strings, the agent prompt, action
// descriptions and the public docs against the copy rules:
//   no em dashes; no "RFI"; no construction framing; no MCP or Teamwork
//   Graph claims; only the allowed statistics; no legal-advice claims
//   (only the "not legal advice" disclaimer). Also checks the disclaimer
//   is present where it must be visible.
// Run: node scripts/copy-lint.mjs   (exit 1 on any finding)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILES = [
  'src/frontend/board.jsx',
  'src/frontend/panel.jsx',
  'src/frontend/components.jsx',
  'src/lib/view.js',
  'src/lib/brief.js',
  'src/lib/samples.js',
  'src/lib/escalation.js',
  'src/index.js',
  'src/services.js',
  'static/agent/prompt.txt',
  'manifest.yml',
  'README.md',
  'DEMO-SCRIPT.md',
  'SUBMISSION-DRAFT.md',
];
export const DISCLAIMER = 'Fides tracks dates and obligations; it is not legal advice.';

// Allowed statistics. Anything else with a % is a finding, except the
// judging weights and the fictional terms inside sample contracts.
const ALLOWED_PERCENT = [/\b11%/, /\b21%/, /\b43%/];
const PERCENT_EXEMPT = [/\(20% each\)/, /^src\/lib\/samples\.js$/];

const RULES = [
  { id: 'em-dash', re: /—/ },
  { id: 'rfi', re: /\bRFIs?\b/ },
  { id: 'construction', re: /\b(construction|subcontract\w*|submittals?|punch list|change orders?|jobsite|general contractor)\b/i },
  { id: 'mcp-or-graph', re: /\bMCP\b|teamwork graph|rovo:mcp|graph:connector|rovo:agentConnector/i },
  { id: 'legal-advice-claim', re: /legal (advice|guidance|opinion)|legally (binding|valid|required)|lawyer[- ]approved/i, unless: /not legal advice/i },
];

export function lint(files = FILES) {
  const findings = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const r of RULES) {
        if (r.re.test(line) && !(r.unless && r.unless.test(line))) findings.push({ file: rel, line: i + 1, rule: r.id, text: line.trim().slice(0, 160) });
      }
      const exempt = PERCENT_EXEMPT.some((x) => x.test(rel) || x.test(line));
      if (!exempt) {
        for (const m of line.matchAll(/\b\d+(?:\.\d+)?\s?%|\bpercent\b/gi)) {
          if (!ALLOWED_PERCENT.some((a) => a.test(m[0]))) findings.push({ file: rel, line: i + 1, rule: 'unapproved-stat', text: line.trim().slice(0, 160) });
        }
      }
    });
  }
  // The disclaimer must stay visible.
  for (const rel of ['src/frontend/components.jsx', 'src/lib/brief.js', 'static/agent/prompt.txt', 'README.md']) {
    if (!fs.readFileSync(path.join(root, rel), 'utf8').includes(DISCLAIMER)) findings.push({ file: rel, line: 0, rule: 'missing-disclaimer', text: DISCLAIMER });
  }
  // The 11% figure must carry its vendor caveat wherever it appears.
  for (const rel of ['README.md', 'SUBMISSION-DRAFT.md']) {
    const t = fs.readFileSync(path.join(root, rel), 'utf8');
    if (/\b11%/.test(t) && !/CLM vendor/.test(t)) findings.push({ file: rel, line: 0, rule: 'stat-without-caveat', text: '11% needs the CLM vendor caveat' });
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = lint();
  for (const x of f) console.log(`${x.file}:${x.line} [${x.rule}] ${x.text}`);
  console.log(f.length ? `copy lint: ${f.length} finding(s)` : 'copy lint: clean');
  process.exit(f.length ? 1 : 0);
}
