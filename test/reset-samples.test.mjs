// reset-samples.mjs: dry run by default, deletes only sample issues.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { plan, isSampleIssue, kindOf } from '../scripts/reset-samples.mjs';

const run = promisify(execFile);
const issue = (key, labels, summary = key) => ({ key, fields: { labels, summary } });

test('plan keeps only issues with a fides-sample label and orders them safely', () => {
  const p = plan([
    issue('CLSD-1', ['fides-agreement', 'fides-sample', 'fides-sample-helios']),
    issue('CLSD-2', ['fides-blocker', 'fides-sample']),
    issue('CLSD-3', ['fides-review', 'fides-sample']),
    issue('CLSD-4', ['fides-escalation', 'fides-esc-1-2', 'fides-sample']),
    issue('CLSD-5', ['fides-agreement']), // real agreement: never touched
    issue('CLSD-6', ['fides-escalation']), // real escalation: never touched
    issue('CLSD-7', ['customer']),
  ]);
  assert.deepEqual(p.map((x) => [x.key, x.kind]), [
    ['CLSD-4', 'escalation'],
    ['CLSD-3', 'review'],
    ['CLSD-2', 'blocker'],
    ['CLSD-1', 'agreement'],
  ]);
  assert.equal(isSampleIssue(['fides-sample-quay']), true);
  assert.equal(isSampleIssue(['fides-samples', 'fides-agreement']), false);
  assert.equal(kindOf(['fides-sample']), 'other sample');
});

function fakeJira(issues) {
  const deleted = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/rest/api/3/search/jql') {
        // Return everything: the script must filter client-side too.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ issues, isLast: true }));
      }
      const m = /^\/rest\/api\/3\/issue\/([^?]+)/.exec(req.url);
      if (req.method === 'DELETE' && m) {
        deleted.push(decodeURIComponent(m[1]));
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, deleted, url: `http://127.0.0.1:${server.address().port}` })));
}

const ENV = { ...process.env, FORGE_EMAIL: 'test@example.com', FORGE_API_TOKEN: 'not-a-real-token', FIDES_RESET_TEST: '1' };
const SCRIPT = new URL('../scripts/reset-samples.mjs', import.meta.url).pathname;
const ISSUES = [
  issue('CLSD-21', ['fides-agreement', 'fides-sample', 'fides-sample-helios'], 'Helios Payroll agreement (sample)'),
  issue('CLSD-22', ['fides-blocker', 'fides-sample'], 'Approval pending'),
  issue('CLSD-9', ['fides-agreement'], 'Real Vendor agreement'),
];

test('dry run lists exactly what it would delete and changes nothing', async () => {
  const j = await fakeJira(ISSUES);
  try {
    const { stdout } = await run(process.execPath, [SCRIPT, '--site', j.url], { env: ENV });
    assert.match(stdout, /Would delete 2 Fides sample issue\(s\)/);
    assert.match(stdout, /CLSD-21\s+agreement/);
    assert.match(stdout, /CLSD-22\s+blocker/);
    assert.doesNotMatch(stdout, /CLSD-9/);
    assert.match(stdout, /Dry run: nothing was changed/);
    assert.doesNotMatch(stdout, /not-a-real-token/, 'token never printed');
    assert.deepEqual(j.deleted, []);
  } finally {
    j.server.close();
  }
});

test('--apply deletes only the sample issues', async () => {
  const j = await fakeJira(ISSUES);
  try {
    const { stdout } = await run(process.execPath, [SCRIPT, '--site', j.url, '--apply'], { env: ENV });
    assert.deepEqual(j.deleted.sort(), ['CLSD-21', 'CLSD-22']);
    assert.match(stdout, /Load samples/);
  } finally {
    j.server.close();
  }
});

test('refuses to run without credentials or with a non-https site', async () => {
  await assert.rejects(run(process.execPath, [SCRIPT, '--site', 'https://x.atlassian.net'], { env: { PATH: process.env.PATH } }), /FORGE_EMAIL/);
  await assert.rejects(run(process.execPath, [SCRIPT, '--site', 'http://evil.example'], { env: ENV }), /Usage/);
});
