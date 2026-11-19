// First paint for the issue panel: build a status view from the
// fides-agreement issue property already on the Jira issue, so the panel
// can render before the slower resolver returns.

import { evaluate, todayIso } from './dates.js';
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

// Fetch the issue property through a requestJira-like function (injected
// so tests do not need the Forge bridge). Call this before invoke('getPanel'):
// a shared bridge can otherwise queue the peek behind a cold resolver.
export async function peekFromIssueKey(key, request) {
  if (!key || typeof request !== 'function') return null;
  try {
    const res = await request(`/rest/api/3/issue/${encodeURIComponent(key)}/properties/fides-agreement`, {
      headers: { Accept: 'application/json' },
    });
    if (!res?.ok) return null;
    const body = typeof res.json === 'function' ? await res.json() : res.body;
    return panelPeekFromProperty(body?.value, todayIso());
  } catch {
    return null;
  }
}
