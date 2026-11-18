// Item 6: the copy lint passes on every UI string, the agent prompt,
// action descriptions and the public docs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lint } from '../scripts/copy-lint.mjs';

test('copy lint is clean', () => {
  const findings = lint();
  assert.deepEqual(findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.text}`), []);
});
