import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Link, SectionMessage, Spinner, Stack, Inline, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import { StatusChip, Footer } from './components';

const ROLE = {
  agreement: null,
  review: 'This is a Fides review issue for the agreement below.',
  blocker: 'This blocker is linked to the agreement below. While it is open it may threaten the notice date.',
  escalation: 'Fides escalated this because an open blocker may put the date below at risk.',
  linked: 'Linked to a Fides agreement.',
};

function Panel() {
  const [d, setD] = useState(null);
  useEffect(() => {
    invoke('getPanel').then(setD).catch(() => setD({ kind: 'error' }));
  }, []);
  if (!d) return <Spinner label="Loading Fides status" />;
  if (d.kind === 'error') {
    return (
      <SectionMessage appearance="error">
        <Text>Fides could not load this issue. Reload the issue to retry.</Text>
      </SectionMessage>
    );
  }
  if (d.kind === 'none') {
    return (
      <Stack space="space.100">
        <Text color="color.text.subtle">This issue is not a Fides agreement and is not linked to one.</Text>
        <Footer text={d.disclaimer} />
      </Stack>
    );
  }
  const a = d.agreement;
  return (
    <Stack space="space.100">
      {ROLE[d.kind] ? <Text color="color.text.subtle">{ROLE[d.kind]}</Text> : null}
      {a.invalid ? (
        <SectionMessage appearance="warning">
          <Text>{`Agreement dates are incomplete: ${a.error}`}</Text>
        </SectionMessage>
      ) : (
        <Stack space="space.075">
          <Inline space="space.100" alignBlock="center">
            <StatusChip status={a.status} />
            <Text weight="medium">{a.vendor}</Text>
          </Inline>
          <Text>{`Notice by ${a.noticeBy} (${a.daysLeft < 0 ? `${-a.daysLeft} days ago` : `${a.daysLeft} days left`}). End date ${a.endDate}, ${a.noticeDays} days notice.`}</Text>
          {a.obligations ? <Text color="color.text.subtle">{`Obligations: ${a.obligations}`}</Text> : null}
          {d.kind !== 'agreement' && d.baseUrl ? (
            <Link href={`${d.baseUrl}/browse/${a.issueKey}`}>{`Agreement ${a.issueKey}`}</Link>
          ) : null}
          {a.confluenceUrl ? (
            <Link href={a.confluenceUrl} openNewTab>
              Contract page in Confluence
            </Link>
          ) : (
            <Text color="color.text.subtle">No contract page linked yet. Link one from the Fides board.</Text>
          )}
        </Stack>
      )}
      <Footer text={d.disclaimer} />
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <Panel />
  </React.StrictMode>
);
