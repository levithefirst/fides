import React, { useEffect, useRef, useState } from 'react';
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
  xcss,
} from '@forge/react';
import { invoke, rovo } from '@forge/bridge';
import { StatusChip, UmberRule, Footer, card } from './components';

const AGENT = { type: 'forge', agentKey: 'fides-agent', agentName: 'Fides' };

// The four Rovo actions, front and centre.
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
            {escalatedIds.has(String(a.issueId)) ? (
              <Text size="small" color="color.text.danger">
                Escalated: open blocker
              </Text>
            ) : null}
          </Stack>
        ),
      },
      { key: 'noticeBy', content: <Text>{a.noticeBy}</Text> },
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
          <Label labelFor="owner">Owner</Label>
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

function AskFides() {
  const [rovoOk, setRovoOk] = useState(true);
  useEffect(() => {
    rovo.isEnabled().then(setRovoOk).catch(() => setRovoOk(false));
  }, []);
  const open = (prompt) => rovo.open({ ...AGENT, prompt }).catch(() => setRovoOk(false));
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Heading size="small">Ask Fides in Rovo</Heading>
        <Text color="color.text.subtle">The Fides agent acts through four actions, as you, with your permissions.</Text>
        <Inline space="space.100" shouldWrap>
          {AGENT_ACTIONS.map((a) => (
            <Button key={a.label} onClick={() => open(a.prompt)} isDisabled={!rovoOk}>
              {a.label}
            </Button>
          ))}
        </Inline>
        {!rovoOk ? (
          <Text size="small" color="color.text.subtle">
            Rovo Chat is not available on this site. Use a site from forge site provision to try the agent.
          </Text>
        ) : null}
      </Stack>
    </Box>
  );
}

function Board() {
  const [data, setData] = useState(null);
  const [group, setGroup] = useState(GROUPS[0]);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [modal, setModal] = useState(null);
  const polls = useRef(0);

  const refresh = async () => setData(await invoke('getBoard'));

  useEffect(() => {
    // Judge mode: seed on first open (idempotent), then show the board.
    invoke('bootstrap').then((d) => {
      setData(d);
      if (d?.seedResult?.state === 'running' || d?.seed?.state === 'running') {
        const t = setInterval(async () => {
          polls.current += 1;
          const next = await invoke('getBoard');
          setData(next);
          if (next?.seed?.state !== 'running' || polls.current > 20) clearInterval(t);
        }, 1500);
      }
    });
  }, []);

  if (!data) {
    return (
      <Stack space="space.200" alignInline="center">
        <Spinner size="large" label="Loading notice board" />
        <Text color="color.text.subtle">Loading the notice board. On a fresh site Fides sets up demo agreements first.</Text>
      </Stack>
    );
  }

  const seedState = data.seed?.state;
  const escalatedIds = new Set((data.escalations || []).map((e) => String(e.agreementId)));
  const groups = groupRows(data.agreements || [], group.value);
  const invalid = (data.agreements || []).filter((a) => a.invalid);

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
    const r = await invoke('loadSamples');
    setBusy(false);
    setFlash(r.ok ? `Samples: ${r.seed.state}` : r.error);
    refresh();
  };

  return (
    <Stack space="space.250">
      <Stack space="space.075">
        <UmberRule />
        <Inline spread="space-between" alignBlock="center" shouldWrap>
          <Stack space="space.050">
            <Heading size="large">Notice board</Heading>
            <Text color="color.text.subtle">
              {`${data.counts.due} Due · ${data.counts.upcoming} Upcoming · ${data.counts.onTrack} On track · today ${data.today}`}
            </Text>
          </Stack>
          <ButtonGroup>
            <Button onClick={() => setModal({ kind: 'add' })}>Add agreement</Button>
            <Button onClick={runScan} isDisabled={busy}>Run scan now</Button>
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

      {flash ? (
        <SectionMessage appearance="information">
          <Text>{flash}</Text>
        </SectionMessage>
      ) : null}

      {seedState === 'running' ? (
        <SectionMessage appearance="information" title="Setting up demo agreements">
          <Inline space="space.100" alignBlock="center">
            <Spinner size="small" label="Seeding" />
            <Text>Creating sample agreements, a blocker and the escalation on this site.</Text>
          </Inline>
        </SectionMessage>
      ) : null}

      {seedState === 'needs-project' || (!data.config?.projectKey && seedState !== 'running') ? (
        <ProjectPicker onPicked={loadSamples} />
      ) : null}

      {data.escalations?.length ? (
        <SectionMessage appearance="warning" title="Threatened milestones escalated">
          <Stack space="space.050">
            {data.escalations.map((e) => (
              <Inline key={e.issueKey} space="space.075" shouldWrap>
                <Link href={e.url || "#"}>{e.issueKey}</Link>
                <Text>{`${e.vendor}: open blocker ${e.blockerKey} may put the ${e.riskKind === 'milestone' ? 'milestone' : 'notice'} date of ${e.dateAtRisk} at risk.`}</Text>
              </Inline>
            ))}
          </Stack>
        </SectionMessage>
      ) : null}

      <AskFides />

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
                  busy={busy}
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
        </Stack>
      ) : seedState !== 'running' ? (
        <EmptyState
          header="No agreements yet"
          description="Load sample agreements to see Due, Upcoming and On track notices, or add your first agreement."
          primaryAction={<Button appearance="primary" onClick={loadSamples} isDisabled={busy}>Load samples</Button>}
        />
      ) : null}

      <Footer text={data.disclaimer} />

      <ModalTransition>
        {modal?.kind === 'add' ? (
          <AddAgreement onClose={() => setModal(null)} onSaved={() => { setModal(null); refresh(); }} />
        ) : null}
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
