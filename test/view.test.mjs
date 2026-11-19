// Board view model (gaps 2, 3 and 4): every clean-site state renders
// something labelled; the first viewport carries the computed notice-by,
// the open blocker, the single escalation and the "why not a date" line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveBoardView, spotlightFor, WHY_LINE, ROVO_NOTE, CONFLUENCE_NOTE, reviewAction } from '../src/lib/view.js';

const helios = {
  issueId: '1', issueKey: 'CLSD-1', vendor: 'Helios Payroll', status: 'DUE', sample: true,
  endDate: '2026-12-21', noticeDays: 30, noticeBy: '2026-11-21', daysLeft: 6, confluenceUrl: 'https://x/wiki/p/1',
  openBlockers: [{ key: 'CLSD-2', summary: 'Approval pending: finance sign-off', statusName: 'To Do' }],
  escalations: [{ issueKey: 'CLSD-12', url: 'https://x/browse/CLSD-12' }],
};
const quay = { issueId: '4', issueKey: 'CLSD-4', vendor: 'Quay Support', status: 'ON_TRACK', sample: true, noticeBy: '2027-03-14', daysLeft: 120 };
const board = (over = {}) => ({ agreements: [helios, quay], escalations: [{ agreementId: '1', issueKey: 'CLSD-12' }], seed: { state: 'done' }, counts: {}, ...over });

const allText = (v) => JSON.stringify(v);

test('never a silent spinner: loading and seeding states are labelled', () => {
  const loading = deriveBoardView(null);
  assert.equal(loading.mode, 'loading');
  assert.ok(loading.banner.title);
  const seeding = deriveBoardView(board({ agreements: [helios], escalations: [] }), { seeding: true });
  assert.equal(seeding.mode, 'seeding');
  assert.equal(seeding.banner.title, 'Seeding sample agreements...');
  assert.match(seeding.banner.text, /1 of 4 sample agreements created/);
  // The Due row renders while seeding, as soon as Helios exists.
  assert.equal(seeding.spotlight.vendor, 'Helios Payroll');
});

test('first viewport: computed notice-by, open blocker, single escalation, why line', () => {
  const s = deriveBoardView(board()).spotlight;
  assert.equal(s.formula, 'Notice by 2026-11-21 = end date 2026-12-21 minus 30 days notice');
  assert.equal(s.blocker.key, 'CLSD-2');
  assert.equal(s.escalation.issueKey, 'CLSD-12');
  assert.equal(s.why, WHY_LINE);
  assert.equal(s.askPrompt, 'Is Helios at risk, and what should I do?');
  // No blocker: no why line, no fake escalation.
  const plain = spotlightFor([{ ...helios, openBlockers: [], escalations: [] }], []);
  assert.equal(plain.why, null);
  assert.equal(plain.escalation, null);
  assert.equal(spotlightFor([quay]), null);
});

test('no Rovo: board and escalation still render, with a note', () => {
  const v = deriveBoardView(board(), { rovo: false });
  assert.equal(v.mode, 'ready');
  assert.equal(v.rovoEnabled, false);
  assert.equal(v.rovoNote, ROVO_NOTE);
  assert.match(ROVO_NOTE, /^Rovo Chat is not available on this site\. Next step: /);
  assert.equal(v.spotlight.escalation.issueKey, 'CLSD-12');
  assert.equal(deriveBoardView(board(), { rovo: true }).rovoNote, null);
});

test('no Confluence: note shown only when no agreement has a page', () => {
  const none = board({ agreements: [{ ...helios, confluenceUrl: null }, quay] });
  assert.equal(deriveBoardView(none).confluenceNote, CONFLUENCE_NOTE);
  assert.equal(deriveBoardView(board()).confluenceNote, null);
});

test('user cannot create issues: clear permission message, never blank', () => {
  const v = deriveBoardView({ agreements: [], escalations: [], seed: { state: 'no-permission', message: 'You do not have permission to create issues.' } });
  assert.equal(v.mode, 'no-permission');
  assert.equal(v.banner.appearance, 'error');
  assert.match(v.banner.text, /permission/);
  assert.equal(v.showPicker, false);
});

test('board load failure shows the error, not a blank board', () => {
  const v = deriveBoardView({ loadError: 'You do not have permission to read the Fides agreement issues in Jira.', loadErrorKind: 'permission', agreements: [] });
  assert.equal(v.mode, 'error');
  assert.match(v.banner.text, /permission/);
});

test('project picker only when no usable project could be picked', () => {
  assert.equal(deriveBoardView(board()).showPicker, false);
  assert.equal(deriveBoardView(board({ config: null })).showPicker, false, 'missing config alone never shows the picker');
  assert.equal(deriveBoardView({ agreements: [], seed: { state: 'needs-project' } }).showPicker, true);
  const noProjects = deriveBoardView({ agreements: [], seed: { state: 'no-projects' } });
  assert.equal(noProjects.showPicker, false);
  assert.match(noProjects.banner.text, /Create a project/);
  // While seeding, never the picker.
  assert.equal(deriveBoardView({ agreements: [], seed: { state: 'needs-project' } }, { seeding: true }).showPicker, false);
});

test('copy rules: no RFI, no em dash', () => {
  const states = [
    deriveBoardView(board(), { rovo: false }),
    deriveBoardView(board(), { seeding: true }),
    deriveBoardView({ agreements: [], seed: { state: 'no-permission' } }),
    deriveBoardView({ agreements: [], seed: { state: 'no-projects' } }),
  ];
  for (const v of states) {
    assert.doesNotMatch(allText(v), /\bRFI\b/);
    assert.doesNotMatch(allText(v), /\u2014/);
  }
});

test('reviewAction prefers an open review link over the create button', () => {
  assert.deepEqual(reviewAction({ status: 'DUE', openReview: { issueKey: 'CLSD-41', url: 'https://example/browse/CLSD-41' } }), {
    type: 'link',
    issueKey: 'CLSD-41',
    url: 'https://example/browse/CLSD-41',
  });
  assert.deepEqual(reviewAction({ status: 'DUE' }), { type: 'create' });
  assert.deepEqual(reviewAction({ status: 'UPCOMING' }), { type: 'none' });
  assert.deepEqual(reviewAction({ status: 'UPCOMING', openReview: { issueKey: 'CLSD-45' } }), {
    type: 'link',
    issueKey: 'CLSD-45',
    url: null,
  });
});
