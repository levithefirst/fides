// First paint for the issue panel: build a status view from the
// fides-agreement issue property already on the Jira issue, so the panel
// can render before the slower resolver returns.

import { evaluate } from './dates.js';
import { DISCLAIMER } from './brief.js';

export function panelPeekFromProperty(property, today) {
  if (!property || property.endDate == null || property.noticeDays == null || property.noticeDays === '') return null;
  const rec = {
    vendor: property.vendor || '',
    endDate: property.endDate,
    noticeDays: Number(property.noticeDays),
    obligations: property.obligations || '',
    confluenceUrl: property.confluenceUrl || null,
    issueKey: property.issueKey || null,
  };
  return { kind: 'agreement', agreement: evaluate(rec, today), baseUrl: '', disclaimer: DISCLAIMER, fromPeek: true };
}
