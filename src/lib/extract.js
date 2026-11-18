// Deterministic extraction of agreement fields from a Confluence contract
// page (storage format or plain text). No AI calls: patterns and tables
// first; the Rovo agent fills gaps from its own reading and the user
// confirms. Every field carries the sentence it came from and a confidence.
//
// Fields: vendor, endDate (YYYY-MM-DD), noticeDays, owner, obligations[<=3]

import { parseDate, formatDate } from './dates.js';
import { storageToText } from './brief.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WORD_NUM = { seven: 7, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, 'forty-five': 45, sixty: 60, ninety: 90, 'one hundred and twenty': 120, 'one hundred twenty': 120, 'one hundred eighty': 180 };

const monthIndex = (m) => MONTHS.findIndex((x) => x.startsWith(m.toLowerCase().slice(0, 3)));
const iso = (y, m, d) => {
  const ms = Date.UTC(y, m, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
  return formatDate(ms);
};

// Every date in a string, in order: ISO, DD/MM/YYYY, "31 December 2026",
// "December 31, 2026", "31st of Dec 2026".
export function findDates(s) {
  const out = [];
  const push = (index, value) => value && out.push({ index, value });
  for (const m of s.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(m.index, parseDate(m[0]) !== null ? m[0] : null);
  for (const m of s.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) push(m.index, iso(+m[3], +m[2] - 1, +m[1]));
  for (const m of s.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MON}\\.?,?\\s+(\\d{4})\\b`, 'gi')))
    push(m.index, iso(+m[3], monthIndex(m[2]), +m[1]));
  for (const m of s.matchAll(new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi')))
    push(m.index, iso(+m[3], monthIndex(m[1]), +m[2]));
  return out.sort((a, b) => a.index - b.index);
}

// "30 days' written notice", "thirty (30) days notice", "notice of 60 days",
// "at least 90 days before the end date", "Notice period: 30 days".
export function findNoticeDays(s) {
  const pats = [
    /(?:\b[a-z-]+\s+)?\((\d{1,3})\)\s*(?:calendar\s+|business\s+)?days?['’]?\s+(?:prior\s+)?(?:written\s+)?notice/i,
    /\b(\d{1,3})\s*(?:calendar\s+)?days?['’]?\s+(?:prior\s+|advance\s+)?(?:written\s+)?notice/i,
    /\bnotice\s+(?:period\s+)?of\s+(?:at\s+least\s+)?(\d{1,3})\s*(?:calendar\s+)?days?\b/i,
    /\bnotice(?:\s+period)?\s*[:=]\s*(\d{1,3})\s*days?\b/i,
    /\bat\s+least\s+(\d{1,3})\s*(?:calendar\s+)?days?\s+(?:before|prior\s+to)\s+(?:the\s+)?(?:end|expiry|expiration|renewal)/i,
  ];
  for (const p of pats) {
    const m = p.exec(s);
    if (m) return Number(m[1]);
  }
  const w = new RegExp(`\\b(${Object.keys(WORD_NUM).join('|')})\\s+days?['’]?\\s+(?:prior\\s+)?(?:written\\s+)?notice`, 'i').exec(s);
  return w ? WORD_NUM[w[1].toLowerCase()] : null;
}

// Key/value rows from storage-format tables: <tr><th>Key</th><td>Value</td></tr>
export function tableRows(storage) {
  const rows = [];
  for (const tr of String(storage || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => storageToText(c[1]));
    if (cells.length >= 2 && cells[0]) rows.push({ key: cells[0].trim(), value: cells[1].trim(), source: `${cells[0].trim()}: ${cells[1].trim()}` });
  }
  return rows;
}

const sentencesOf = (text) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 3);

const KEYS = {
  vendor: /^(vendor|supplier|provider|counterparty|service provider|company)$/i,
  endDate: /^(end date|expiry|expiry date|expiration|expiration date|term end|end of term|renewal date|contract end)$/i,
  notice: /^(notice|notice period|notice days|termination notice)$/i,
  owner: /^(owner|contract owner|business owner|account owner|internal owner)$/i,
};

const field = (value, source, confidence) => ({ value, source, confidence });

export function extractAgreement({ title = '', storage = '', text = null } = {}) {
  const plain = text ?? storageToText(storage);
  const sentences = sentencesOf(plain);
  const rows = tableRows(storage);
  const fromTable = (re) => rows.find((r) => re.test(r.key));
  const fields = { vendor: null, endDate: null, noticeDays: null, owner: null, obligations: [] };

  // Vendor: table, then title patterns, then "between X and Y" (low).
  const tv = fromTable(KEYS.vendor);
  if (tv?.value) fields.vendor = field(tv.value, tv.source, 'high');
  else {
    const t = String(title);
    const m =
      /^Fides sample contract:\s*(.+)$/i.exec(t) ||
      /\b(?:agreement|contract)\s+with\s+(.+?)(?:\s+[-(|]|$)/i.exec(t) ||
      /^(.+?)\s+(?:master services|services|subscription|licen[cs]e|support|saas)?\s*(?:agreement|contract)\b/i.exec(t);
    if (m && m[1].trim()) fields.vendor = field(m[1].trim(), `Page title: ${t}`, 'medium');
    else {
      const s = sentences.find((x) => /\bbetween\b.+\band\b/i.test(x));
      const b = s && /\band\s+([A-Z][\w&.,' -]{2,60}?)(?:\s*\(|,|\.|$)/.exec(s);
      if (b) fields.vendor = field(b[1].trim(), s, 'low');
    }
  }

  // End date: table, then sentences that talk about expiry / end / renewal.
  const te = fromTable(KEYS.endDate);
  const ted = te && findDates(te.value)[0];
  if (ted) fields.endDate = field(ted.value, te.source, 'high');
  else {
    const scored = [];
    for (const s of sentences) {
      const dates = findDates(s);
      if (!dates.length) continue;
      const strong = /\b(expir\w*|end date|ends on|terminates on|term (?:ends|shall end)|until)\b/i.test(s);
      const weak = /\b(renew\w*|term|terminat\w*)\b/i.test(s);
      if (strong || weak) scored.push({ s, d: dates[dates.length - 1].value, conf: strong && dates.length === 1 ? 'high' : 'medium' });
    }
    if (scored.length) {
      const best = scored.find((x) => x.conf === 'high') || scored[0];
      fields.endDate = field(best.d, best.s, scored.length > 1 && best.conf !== 'high' ? 'low' : best.conf);
    } else {
      const all = sentences.flatMap((s) => findDates(s).map((d) => ({ s, d: d.value })));
      if (all.length === 1) fields.endDate = field(all[0].d, all[0].s, 'low');
    }
  }

  // Notice period: table, then the first notice clause.
  const tn = fromTable(KEYS.notice);
  const tnd = tn && findNoticeDays(`notice period: ${tn.value}`);
  if (tnd !== null && tnd !== undefined) fields.noticeDays = field(tnd, tn.source, 'high');
  else {
    const s = sentences.find((x) => findNoticeDays(x) !== null);
    if (s) fields.noticeDays = field(findNoticeDays(s), s, /\b(terminat|renew|cancel|non-renewal)\w*/i.test(s) ? 'high' : 'medium');
  }

  // Owner: table, then "Contract owner: X" / "owned by X".
  const to = fromTable(KEYS.owner);
  if (to?.value) fields.owner = field(to.value, to.source, 'high');
  else {
    for (const s of sentences) {
      const m = /\b(?:contract|business|internal)?\s*owner\s*[:-]\s*([^.;\n]{2,80})/i.exec(s) || /\bowned by\s+([^.;\n]{2,80})/i.exec(s);
      if (m) {
        fields.owner = field(m[1].trim(), s, 'medium');
        break;
      }
    }
  }

  // Obligations: duty sentences, not the notice clause, up to 3.
  const noticeSrc = fields.noticeDays?.source;
  fields.obligations = sentences
    .filter((s) => s !== noticeSrc && s.length < 300)
    .filter((s) => /\b(shall|must|will provide|is required to|owes?|owed|obligat\w*|report\w*|sla|service credits?|true-?up|proof of insurance)\b/i.test(s))
    .filter((s) => findNoticeDays(s) === null)
    .slice(0, 3)
    .map((s) => field(s, s, 'medium'));

  const required = ['vendor', 'endDate', 'noticeDays'];
  const missing = required.filter((k) => !fields[k]);
  if (!fields.owner) missing.push('owner');
  const lowConfidence = Object.entries(fields)
    .filter(([k, v]) => k !== 'obligations' && v && v.confidence === 'low')
    .map(([k]) => k);
  return { fields, missing, lowConfidence, complete: required.every((k) => fields[k]) };
}
