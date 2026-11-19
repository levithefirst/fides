// Labelled one-line summaries for Rovo CREATE results, so a judge cannot
// read the agreement key as the review or escalation key.

// Strip a leading "Review:" and a trailing Jira status word so the result
// never reads "Review: CLSD-45: Review: … Open".
export function cleanReviewTitle(title) {
  let s = String(title || '').trim();
  s = s.replace(/^\s*Review:\s*/i, '');
  s = s.replace(/\s+\((?:status:\s*)?(?:To Do|Open|In Progress|Done|Closed|Resolved)\)\s*$/i, '');
  s = s.replace(/\s+(?:To Do|Open|In Progress|Done|Closed|Resolved)\s*$/i, '');
  return s.trim();
}

export function reviewResultLine({ issueKey, vendor, reviewKey, created, reviewTitle }) {
  const outcome = created ? 'created' : 'reused, no duplicate created';
  const title = cleanReviewTitle(reviewTitle);
  const review = `Review: ${reviewKey} (${outcome}).`;
  return title
    ? `Agreement: ${issueKey} ${vendor}. ${review} ${title}.`
    : `Agreement: ${issueKey} ${vendor}. ${review}`;
}

export function escalationResultLine(items) {
  if (!items?.length) return 'No escalation issue was created or reused.';
  return items
    .map((it) => {
      const outcome = it.created ? 'created' : 'reused, no duplicate created';
      const head = it.issueKey && it.vendor ? `Agreement: ${it.issueKey} ${it.vendor}. ` : '';
      const title = cleanReviewTitle(it.escalationTitle);
      const line = `${head}Escalation: ${it.escalationKey} (${outcome}).`;
      return title ? `${line} ${title}.` : line;
    })
    .join(' ');
}
