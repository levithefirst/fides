import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  DatePicker,
  DynamicTable,
  EmptyState,
  Heading,
  Inline,
  Label,
  Link,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Text,
  TextArea,
  Textfield,
  UserPicker,
  xcss,
} from '@forge/react';
import { invoke, rovo } from '@forge/bridge';
import { StatusChip, UmberRule, Footer, card } from './components';
import { deriveBoardView, ROVO_NOTE } from '../lib/view.js';

const AGENT = { type: 'forge', agentKey: 'fides-agent', agentName: 'Fides' };

// The four Rovo actions, one button each, after the chained ask.
const AGENT_ACTIONS = [
  { label: 'List upcoming notices', prompt: 'List the agreements with notices due in the next 60 days.' },
  { label: 'Create a review issue', prompt: 'Create a review issue for the most urgent Due agreement.' },
  { label: 'Escalate threatened milestones', prompt: 'Escalate any threatened milestones: open blockers on agreements whose notice date is within 14 days.' },
  { label: 'Draft a renew / cancel brief', prompt: 'Draft a hedged renew, cancel or renegotiate brief for the most urgent agreement, using its Confluence contract page.' },
];

const GROUPS = [
  { label: 'Group by status', value: 'status' },
  { label: 'Group by 30 / 60 / 90 day window', value: 'window' },
];

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');
const browse = (base, key) => (base && key ? `${base}/browse/${key}` : '#');

function groupRows(agreements, mode) {
  if (mode === 'window') {
    const buckets = [
      { title: 'Notice date passed', test: (a) => a.window === 'past' },
      { title: 'Within 30 days', test: (a) => a.window === 30 },
      { title: 'Within 60 days', test: (a) => a.window === 60 },
      { title: 'Within 90 days', test: (a) => a.window === 90 },
      { title: 'Later than 90 days', test: (a) => a.window === null },
    ];
    return buckets.map((b) => ({ title: b.title, items: agreements.filter((a) => !a.invalid && b.test(a)) }));
  }
  return [
    { title: 'Due', items: agreements.filter((a) => a.status === 'DUE') },
    { title: 'Upcoming', items: agreements.filter((a) => a.status === 'UPCOMING') },
    { title: 'On track', items: agreements.filter((a) => a.status === 'ON_TRACK') },
  ];
}

const HEAD = {
  cells: [
    { key: 'status', content: 'Status' },
    { key: 'vendor', content: 'Agreement' },
    { key: 'noticeBy', content: 'Notice by' },
    { key: 'days', content: 'Days left' },
    { key: 'owner', content: 'Owner' },
    { key: 'page', content: 'Contract page' },
    { key: 'actions', content: '' },
  ],
};

function AgreementTable({ items, base, escalatedIds, onReview, onLinkPage, busy }) {
  const rows = items.map((a) => ({
    key: String(a.issueId),
    cells: [
      { key: 'status', content: <StatusChip status={a.status} /> },
      {
        key: 'vendor',
        content: (
          <Stack space="space.025">
            <Link href={browse(base, a.issueKey)} openNewTab={false}>
              {`${a.issueKey}  ${a.vendor}`}
            </Link>
            {(a.openBlockers || []).map((bl) => (
              <Inline key={bl.key} space="space.050" shouldWrap>
                <Text size="small">Open blocker:</Text>
                <Link href={bl.url || browse(base, bl.key)}>{bl.key}</Link>
              </Inline>
            ))}
            {(a.escalations || []).map((e) => (
              <Inline key={e.issueKey} space="space.050" shouldWrap>
                <Text size="small" color="color.text.danger">Escalated:</Text>
                <Link href={e.url || browse(base, e.issueKey)}>{e.issueKey}</Link>
                {notifyText(e.notify) ? <Text size="small" color="color.text.subtle">{notifyText(e.notify)}</Text> : null}
              </Inline>
            ))}
            {!(a.escalations || []).length && escalatedIds.has(String(a.issueId)) ? (
              <Text size="small" color="color.text.danger">Escalated: open blocker</Text>
            ) : null}
          </Stack>
        ),
      },
      {
        key: 'noticeBy',
        content: (
          <Stack space="space.025">
            <Text>{a.noticeBy}</Text>
            <Text size="small" color="color.text.subtle">{`end ${a.endDate} minus ${a.noticeDays} days`}</Text>
          </Stack>
        ),
      },
      { key: 'days', content: <Text>{a.daysLeft < 0 ? `${-a.daysLeft} days ago` : `${a.daysLeft}`}</Text> },
      { key: 'owner', content: <Text>{a.owner || 'n/a'}</Text> },
      {
        key: 'page',
        content: a.confluenceUrl ? (
          <Link href={a.confluenceUrl} openNewTab>
            Open page
          </Link>
        ) : (
          <Button appearance="subtle" onClick={() => onLinkPage(a)}>
            Link a page
          </Button>
        ),
      },
      {
        key: 'actions',
        content:
          a.status === 'DUE' ? (
            <Button isDisabled={busy} onClick={() => onReview(a)}>
              Create review
            </Button>
          ) : null,
      },
    ],
  }));
  return <DynamicTable head={HEAD} rows={rows} label="Agreements" />;
}

const IMPORT_HELP =
  'Paste rows from a spreadsheet with a header row: vendor, end date (YYYY-MM-DD or DD/MM/YYYY), notice days, owner, and an optional Confluence page link. Up to 100 rows.';
const IMPORT_HEAD = {
  cells: [
    { key: 'line', content: 'Row' },
    { key: 'vendor', content: 'Vendor' },
    { key: 'end', content: 'End date' },
    { key: 'notice', content: 'Notice days' },
    { key: 'owner', content: 'Owner' },
    { key: 'check', content: 'Check' },
  ],
};

function ImportAgreements({ onClose, onDone }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const doPreview = async () => {
    setBusy(true);
    setErr(null);
    const r = await invoke('previewImport', { text });
    setBusy(false);
    if (!r.ok) setErr(r.error);
    setPreview(r.ok ? r : null);
  };
  const doImport = async () => {
    setBusy(true);
    const all = [];
    for (let from = 0; from < preview.rows.length; from += 10) {
      const r = await invoke('runImport', { text, from, to: from + 10 });
      if (!r.ok) {
        setErr(r.error);
        break;
      }
      all.push(...r.results);
      setResults([...all]);
    }
    setBusy(false);
    onDone();
  };

  const check = (r) =>
    r.errors.length ? `Error: ${r.errors.join(' ')}` : r.duplicate ? `Skip: ${r.duplicate}` : 'Ready';
  const counts = (st) => (results || []).filter((x) => x.status === st).length;

  return (
    <Modal onClose={onClose} width="x-large">
      <ModalHeader>
        <ModalTitle>Import agreements</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.150">
          <Text color="color.text.subtle">{IMPORT_HELP}</Text>
          {err ? <SectionMessage appearance="error"><Text>{err}</Text></SectionMessage> : null}
          {!results ? (
            <>
              <Label labelFor="import-rows">Rows to import</Label>
              <TextArea id="import-rows" value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} />
            </>
          ) : null}
          {preview && !results ? (
            <Stack space="space.100">
              <Text weight="medium">{`${preview.counts.valid} ready, ${preview.counts.duplicates} duplicate, ${preview.counts.invalid} with errors. Nothing is created until you confirm.`}</Text>
              <DynamicTable
                head={IMPORT_HEAD}
                rowsPerPage={20}
                rows={preview.rows.map((r) => ({
                  key: String(r.line),
                  cells: [
                    { key: 'line', content: <Text>{String(r.line)}</Text> },
                    { key: 'vendor', content: <Text>{r.vendor || ' '}</Text> },
                    { key: 'end', content: <Text>{r.endDate || r.endDateRaw || ' '}</Text> },
                    { key: 'notice', content: <Text>{r.noticeDaysRaw || ' '}</Text> },
                    { key: 'owner', content: <Text>{r.owner || ' '}</Text> },
                    { key: 'check', content: <Text color={r.errors.length ? 'color.text.danger' : 'color.text'}>{check(r)}</Text> },
                  ],
                }))}
              />
            </Stack>
          ) : null}
          {results ? (
            <Stack space="space.100">
              <Text weight="medium">{`${counts('created')} created, ${counts('skipped')} skipped, ${counts('failed')} failed.`}</Text>
              <DynamicTable
                head={{ cells: [{ key: 'line', content: 'Row' }, { key: 'vendor', content: 'Vendor' }, { key: 'result', content: 'Result' }] }}
                rowsPerPage={20}
                rows={results.map((r) => ({
                  key: String(r.line),
                  cells: [
                    { key: 'line', content: <Text>{String(r.line)}</Text> },
                    { key: 'vendor', content: <Text>{r.vendor || ' '}</Text> },
                    {
                      key: 'result',
                      content: (
                        <Text color={r.status === 'failed' ? 'color.text.danger' : 'color.text'}>
                          {r.status === 'created' ? `Created ${r.issueKey}` : r.status === 'skipped' ? `Skipped: ${r.reason}` : `Failed: ${r.reason}`}
                        </Text>
                      ),
                    },
                  ],
                }))}
              />
            </Stack>
          ) : null}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <ButtonGroup>
          <Button appearance="subtle" onClick={onClose}>{results ? 'Close' : 'Cancel'}</Button>
          {!results ? (
            preview ? (
              <Button appearance="primary" isDisabled={busy || !preview.counts.valid} onClick={doImport}>
                {`Import ${preview.counts.valid} agreement${preview.counts.valid === 1 ? '' : 's'}`}
              </Button>
            ) : (
              <Button appearance="primary" isDisabled={busy || !text.trim()} onClick={doPreview}>Preview</Button>
            )
          ) : null}
        </ButtonGroup>
      </ModalFooter>
    </Modal>
  );
}

function AddAgreement({ onClose, onSaved }) {
  const [f, setF] = useState({ vendor: '', endDate: '', noticeDays: '30', spend: '', owner: '', obligations: '', confluenceUrl: '' });
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const up = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  const save = async () => {
    setSaving(true);
    setErr(null);
    const r = await invoke('createAgreement', { ...f, noticeDays: Number(f.noticeDays) });
    setSaving(false);
    if (r.ok) onSaved();
    else setErr(r.error);
  };
  return (
    <Modal onClose={onClose}>
      <ModalHeader>
        <ModalTitle>Add agreement</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.150">
          {err ? <SectionMessage appearance="error"><Text>{err}</Text></SectionMessage> : null}
          <Label labelFor="vendor">Vendor</Label>
          <Textfield id="vendor" value={f.vendor} onChange={up('vendor')} />
          <Label labelFor="endDate">End date</Label>
          <DatePicker id="endDate" value={f.endDate} onChange={up('endDate')} />
          <Label labelFor="noticeDays">Notice period (days)</Label>
          <Textfield id="noticeDays" type="number" value={f.noticeDays} onChange={up('noticeDays')} />
          <UserPicker
            label="Owner (gets review and escalation issues in Jira)"
            name="ownerAccountId"
            placeholder="Pick a Jira user"
            onChange={(u) => setF({ ...f, ownerAccountId: u?.id || null, owner: u?.name || f.owner })}
          />
          <Label labelFor="owner">Owner team or name (optional, shown on the board)</Label>
          <Textfield id="owner" value={f.owner} onChange={up('owner')} />
          <Label labelFor="spend">Spend (display only)</Label>
          <Textfield id="spend" value={f.spend} onChange={up('spend')} />
          <Label labelFor="obligations">Key obligations</Label>
          <TextArea id="obligations" value={f.obligations} onChange={up('obligations')} />
          <Label labelFor="page">Confluence contract page URL (optional)</Label>
          <Textfield id="page" value={f.confluenceUrl} onChange={up('confluenceUrl')} />
        </Stack>
      </ModalBody>
      <ModalFooter>
        <ButtonGroup>
          <Button appearance="subtle" onClick={onClose}>Cancel</Button>
          <Button appearance="primary" isDisabled={saving} onClick={save}>Save agreement</Button>
        </ButtonGroup>
      </ModalFooter>
    </Modal>
  );
}

function LinkPage({ agreement, onClose, onSaved }) {
  const [ref, setRef] = useState('');
  const [err, setErr] = useState(null);
  const save = async () => {
    const r = await invoke('linkPage', { issueId: agreement.issueId, pageRef: ref });
    if (r.ok) onSaved();
    else setErr(r.error);
  };
  return (
    <Modal onClose={onClose}>
      <ModalHeader>
        <ModalTitle>{`Link a contract page to ${agreement.vendor}`}</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.100">
          {err ? <SectionMessage appearance="error"><Text>{err}</Text></SectionMessage> : null}
          <Label labelFor="pageRef">Confluence page URL or id</Label>
          <Textfield id="pageRef" value={ref} onChange={(e) => setRef(e.target.value)} />
        </Stack>
      </ModalBody>
      <ModalFooter>
        <ButtonGroup>
          <Button appearance="subtle" onClick={onClose}>Cancel</Button>
          <Button appearance="primary" onClick={save}>Link page</Button>
        </ButtonGroup>
      </ModalFooter>
    </Modal>
  );
}

function ProjectPicker({ onPicked }) {
  const [projects, setProjects] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    invoke('listProjects').then((r) => (r.ok ? setProjects(r.projects) : setErr(r.error)));
  }, []);
  const pick = async (opt) => {
    const r = await invoke('setProject', { projectKey: opt.value });
    if (r.ok) onPicked();
    else setErr(r.error);
  };
  return (
    <SectionMessage appearance="information" title="Pick a Jira project for agreements">
      <Stack space="space.100">
        <Text>Fides creates agreement, review and escalation issues in one project on this site.</Text>
        {err ? <Text color="color.text.danger">{err}</Text> : null}
        {projects ? (
          <Select
            inputId="project"
            aria-label="Project"
            options={projects.map((p) => ({ label: `${p.name} (${p.key})`, value: p.key }))}
            onChange={pick}
          />
        ) : (
          <Spinner label="Loading projects" />
        )}
      </Stack>
    </SectionMessage>
  );
}

function AskFides({ rovoEnabled, rovoNote, spotlight }) {
  const [failed, setFailed] = useState(false);
  const open = (prompt) => rovo.open({ ...AGENT, prompt }).catch(() => setFailed(true));
  const disabled = !rovoEnabled || failed;
  const chained = spotlight?.askPrompt || 'Is Helios at risk, and what should I do?';
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Heading size="small">Ask Fides in Rovo</Heading>
          <Text size="small" color="color.text.subtle">Four actions, run as you, with your permissions.</Text>
        </Inline>
        <Inline space="space.100" shouldWrap>
          <Button appearance="primary" onClick={() => open(chained)} isDisabled={disabled}>
            {chained}
          </Button>
          {AGENT_ACTIONS.map((a) => (
            <Button key={a.label} onClick={() => open(a.prompt)} isDisabled={disabled}>
              {a.label}
            </Button>
          ))}
        </Inline>
        {rovoNote || failed ? (
          <Text size="small" color="color.text.subtle">
            {rovoNote || ROVO_NOTE}
          </Text>
        ) : null}
      </Stack>
    </Box>
  );
}

// First viewport: the most urgent Due agreement with its computed notice-by,
// its open blocker and its single escalation.
function Spotlight({ s, base }) {
  if (!s) return null;
  return (
    <Box xcss={card}>
      <Stack space="space.075">
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <StatusChip status="DUE" />
          <Link href={browse(base, s.issueKey)}>{`${s.issueKey}  ${s.vendor}`}</Link>
          <Text weight="medium">{`Notice by ${s.noticeByShort}, ${s.timing}`}</Text>
        </Inline>
        <Text color="color.text.subtle">{s.formula}</Text>
        {s.blocker ? (
          <Inline space="space.075" shouldWrap>
            <Text weight="medium">Open blocker:</Text>
            <Link href={s.blocker.url || browse(base, s.blocker.key)}>{s.blocker.key}</Link>
            <Text>{`${s.blocker.summary || ''}${s.blocker.statusName ? ` (${s.blocker.statusName})` : ''}`}</Text>
          </Inline>
        ) : (
          <Text color="color.text.subtle">No open blocker is linked.</Text>
        )}
        {s.escalation ? (
          <Inline space="space.075" shouldWrap>
            <Text weight="medium">Escalation:</Text>
            <Link href={s.escalation.url || browse(base, s.escalation.issueKey)}>{s.escalation.issueKey}</Link>
            <Text>{`this blocker may put the notice date of ${s.noticeByShort} at risk.`}</Text>
            {notifyText(s.escalation.notify) ? <Text color="color.text.subtle">{notifyText(s.escalation.notify)}</Text> : null}
          </Inline>
        ) : s.blocker ? (
          <Text color="color.text.subtle">Escalation pending.</Text>
        ) : null}
        {s.why ? <Text weight="bold">{s.why}</Text> : null}
      </Stack>
    </Box>
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now(); // board script start, for the first-paint timing

// Plain words for how the owner hears about an escalation.
const notifyText = (n) =>
  !n ? null : n.notified ? 'Owner notified via Jira' : 'Not assigned: no owner account found. Assign it in Jira.';

function Board() {
  const [data, setData] = useState(null);
  const [seeding, setSeeding] = useState(false);
  const [rovoOn, setRovoOn] = useState(null);
  const [group, setGroup] = useState(GROUPS[0]);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [modal, setModal] = useState(null);

  const refresh = async () => setData(await invoke('getBoard'));

  useEffect(() => {
    rovo.isEnabled().then((v) => setRovoOn(Boolean(v))).catch(() => setRovoOn(false));
    let finished = false;
    let freshSeen = false;
    let painted = false;
    // First useful paint: the first time agreements are on screen.
    const markPaint = (d, source) => {
      if (painted || !d?.agreements?.length) return;
      painted = true;
      invoke('logPaint', { ms: Date.now() - T0, source, agreements: d.agreements.length }).catch(() => {});
    };
    (async () => {
      // 1. Paint from this user's last snapshot (one KVS read), while the
      //    fresh board loads in parallel. Fresh data always wins.
      const freshP = invoke('getBoard').catch(() => null);
      invoke('getSnapshot')
        .then((snap) => {
          if (snap && !freshSeen) {
            setData(snap);
            markPaint(snap, 'snapshot');
          }
        })
        .catch(() => {});
      const first = await freshP;
      freshSeen = true;
      if (first) {
        setData(first);
        markPaint(first, 'fresh');
      }
      const st = first?.seed?.state;
      const needsSeed = st !== 'done' && st !== 'skipped';
      // 2. Seed (idempotent) while polling, so the Helios row and its
      //    escalation render as soon as they exist.
      let poll = null;
      if (needsSeed) {
        setSeeding(true);
        poll = setInterval(async () => {
          const next = await invoke('getBoard').catch(() => null);
          if (next && !finished) {
            setData(next);
            markPaint(next, 'seeding');
          }
        }, 1000);
      }
      let res = needsSeed || !first ? await invoke('bootstrap').catch(() => null) : null;
      // The install trigger may hold the seed lock: wait for it, then retry.
      for (let i = 0; res?.seedResult?.state === 'running' && i < 20; i += 1) {
        await sleep(1500);
        res = await invoke('bootstrap').catch(() => null);
      }
      // Warm site: run the Confluence backfill in the background, no repaint needed.
      if (!needsSeed && first) {
        invoke('backfill')
          .then(async (r) => {
            if (r?.linked) setData(await invoke('getBoard'));
          })
          .catch(() => {});
      }
      finished = true;
      if (poll) clearInterval(poll);
      setSeeding(false);
      if (res) {
        setData(res);
        markPaint(res, 'seeded');
      } else if (!first) setData({ loadError: 'Fides could not reach its backend. Reload the page to retry.', agreements: [], counts: { due: 0, upcoming: 0, onTrack: 0 } });
    })();
  }, []);

  const view = deriveBoardView(data, { seeding, rovo: rovoOn });

  if (view.mode === 'loading') {
    return (
      <Stack space="space.200">
        <UmberRule />
        <Heading size="large">Notice board</Heading>
        <SectionMessage appearance="information" title={view.banner.title}>
          <Inline space="space.100" alignBlock="center">
            <Spinner size="small" label="Loading" />
            <Text>{view.banner.text}</Text>
          </Inline>
        </SectionMessage>
      </Stack>
    );
  }

  const escalatedIds = new Set((data.escalations || []).map((e) => String(e.agreementId)));
  const groups = groupRows(data.agreements || [], group.value);
  const invalid = (data.agreements || []).filter((a) => a.invalid);
  const counts = data.counts || { due: 0, upcoming: 0, onTrack: 0 };

  const runScan = async () => {
    setBusy(true);
    const r = await invoke('runScanNow');
    setBusy(false);
    setFlash(r.ok ? 'Scan finished.' : `Scan finished with errors: ${(r.lastRun?.errors || []).join('; ')}`);
    refresh();
  };
  const review = async (a) => {
    setBusy(true);
    const r = await invoke('createReview', { issueId: a.issueId });
    setBusy(false);
    setFlash(r.ok ? `${r.created ? 'Created' : 'Already open'}: review issue ${r.issueKey}` : r.error);
  };
  const loadSamples = async () => {
    setBusy(true);
    setSeeding(true);
    const r = await invoke('loadSamples');
    setSeeding(false);
    setBusy(false);
    setFlash(r.ok ? `Samples: ${r.seed.state}` : r.error);
    refresh();
  };

  return (
    <Stack space="space.200">
      <Stack space="space.075">
        <UmberRule />
        <Inline spread="space-between" alignBlock="center" shouldWrap>
          <Stack space="space.050">
            <Heading size="large">Notice board</Heading>
            <Text color="color.text.subtle">
              {`${counts.due} Due · ${counts.upcoming} Upcoming · ${counts.onTrack} On track · today ${data.today || ''}${view.freshness ? ` · ${view.freshness}` : ''}`}
            </Text>
          </Stack>
          <ButtonGroup>
            <Button onClick={() => setModal({ kind: 'add' })} isDisabled={!view.canCreate}>Add agreement</Button>
            <Button onClick={() => setModal({ kind: 'import' })} isDisabled={!view.canCreate}>Import agreements</Button>
            <Button onClick={runScan} isDisabled={busy || seeding || !view.canCreate}>Run scan now</Button>
          </ButtonGroup>
        </Inline>
        <Text size="small" color={data.lastRun && !data.lastRun.ok ? 'color.text.danger' : 'color.text.subtle'}>
          {data.lastRun
            ? `Last scan ${fmtTime(data.lastRun.finishedAt || data.lastRun.at)} (${data.lastRun.source}): ${
                data.lastRun.ok ? 'ok' : `failed, ${data.lastRun.errors?.[0] || 'see logs'}`
              }. Last successful scan: ${fmtTime(data.lastRun.lastSuccessAt)}.`
            : 'No scan has run yet. The daily scan starts about five minutes after deploy.'}
        </Text>
      </Stack>

      {view.banner && view.mode !== 'empty' ? (
        <SectionMessage appearance={view.banner.appearance} title={view.banner.title}>
          <Stack space="space.050">
            <Inline space="space.100" alignBlock="center">
              {view.banner.spinner ? <Spinner size="small" label="Seeding" /> : null}
              <Text>{view.banner.text}</Text>
            </Inline>
            {view.banner.detail ? <Text size="small" color="color.text.subtle">{view.banner.detail}</Text> : null}
          </Stack>
        </SectionMessage>
      ) : null}

      <Spotlight s={view.spotlight} base={data.baseUrl} />

      <AskFides rovoEnabled={view.rovoEnabled} rovoNote={view.rovoNote} spotlight={view.spotlight} />

      {flash ? (
        <SectionMessage appearance="information">
          <Text>{flash}</Text>
        </SectionMessage>
      ) : null}

      {view.showPicker ? <ProjectPicker onPicked={loadSamples} /> : null}

      {data.agreements?.length ? (
        <Stack space="space.200">
          <Box xcss={xcss({ maxWidth: '360px' })}>
            <Select inputId="group" aria-label="Grouping" options={GROUPS} value={group} onChange={setGroup} />
          </Box>
          {groups.map((g) =>
            g.items.length ? (
              <Stack key={g.title} space="space.100">
                <Heading size="small">{`${g.title} (${g.items.length})`}</Heading>
                <AgreementTable
                  items={g.items}
                  base={data.baseUrl}
                  escalatedIds={escalatedIds}
                  busy={busy || !view.canCreate}
                  onReview={review}
                  onLinkPage={(a) => setModal({ kind: 'link', agreement: a })}
                />
              </Stack>
            ) : null
          )}
          {invalid.length ? (
            <SectionMessage appearance="warning" title="Some agreements have incomplete dates">
              <Text>{invalid.map((a) => a.issueKey || a.vendor).join(', ')}</Text>
            </SectionMessage>
          ) : null}
          {view.confluenceNote ? <Text size="small" color="color.text.subtle">{view.confluenceNote}</Text> : null}
        </Stack>
      ) : view.showEmpty ? (
        <EmptyState
          header={view.banner?.sentence || 'No agreements are tracked yet.'}
          description={`Next step: ${view.banner?.nextStep || 'Load the samples, import rows from a spreadsheet, or add your first agreement.'}`}
          primaryAction={<Button appearance="primary" onClick={loadSamples} isDisabled={busy || !view.canCreate}>Load samples</Button>}
        />
      ) : null}

      <Footer text={data.disclaimer} />

      <ModalTransition>
        {modal?.kind === 'add' ? (
          <AddAgreement onClose={() => setModal(null)} onSaved={() => { setModal(null); refresh(); }} />
        ) : null}
        {modal?.kind === 'import' ? <ImportAgreements onClose={() => setModal(null)} onDone={refresh} /> : null}
        {modal?.kind === 'link' ? (
          <LinkPage agreement={modal.agreement} onClose={() => setModal(null)} onSaved={() => { setModal(null); refresh(); }} />
        ) : null}
      </ModalTransition>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <Board />
  </React.StrictMode>
);
