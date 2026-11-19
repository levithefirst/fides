import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelPeekFromProperty, peekFromIssueKey } from '../src/lib/panelPeek.js';

test('panelPeekFromProperty paints a Due agreement from the issue property', () => {
  const d = panelPeekFromProperty(
    {
      vendor: 'Helios Payroll',
      endDate: '2026-12-24',
      noticeDays: 30,
      obligations: 'Auto-renews',
      confluenceUrl: 'https://example/wiki/pages/3866625',
    },
    '2026-11-19'
  );
  assert.equal(d.kind, 'agreement');
  assert.equal(d.fromPeek, true);
  assert.equal(d.agreement.vendor, 'Helios Payroll');
  assert.equal(d.agreement.status, 'DUE');
  assert.equal(d.agreement.noticeBy, '2026-11-24');
  assert.equal(d.agreement.confluenceUrl, 'https://example/wiki/pages/3866625');
  assert.equal(panelPeekFromProperty(null, '2026-11-19'), null);
  assert.equal(panelPeekFromProperty({ vendor: 'X' }, '2026-11-19'), null);
});


test('peekFromIssueKey reads the issue property through the given request function', async () => {
  const calls = [];
  const request = async (path, opts) => {
    calls.push({ path, opts });
    return {
      ok: true,
      json: async () => ({
        value: { vendor: 'Helios Payroll', endDate: '2026-12-24', noticeDays: 30 },
      }),
    };
  };
  const d = await peekFromIssueKey('CLSD-35', request);
  assert.equal(d.fromPeek, true);
  assert.equal(d.agreement.vendor, 'Helios Payroll');
  assert.match(calls[0].path, /CLSD-35\/properties\/fides-agreement/);
  assert.equal(await peekFromIssueKey('', request), null);
  assert.equal(await peekFromIssueKey('CLSD-35', async () => ({ ok: false })), null);
});
