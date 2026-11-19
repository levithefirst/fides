// Labelled one-line summaries for Rovo CREATE results, so a judge cannot
// read the agreement key as the review or escalation key.

export function reviewResultLine({ issueKey, vendor, reviewKey, created }) {
  const outcome = created ? 'created' : 'reused, no duplicate created';
  return `Agreement: ${issueKey} ${vendor}. Review: ${reviewKey} (${outcome}).`;
}

export function escalationResultLine(items) {
  if (!items?.length) return 'No escalation issue was created or reused.';
  return items
    .map((it) => {
      const outcome = it.created ? 'created' : 'reused, no duplicate created';
      const head = it.issueKey && it.vendor ? `Agreement: ${it.issueKey} ${it.vendor}. ` : '';
      return `${head}Escalation: ${it.escalationKey} (${outcome}).`;
    })
    .join(' ');
}
