// Paste-rows import: parse rows copied from a spreadsheet (tab separated)
// or a CSV file (comma separated), with a header row. Pure, so the board
// preview and the server-side import validate identically.
//
// Columns (header names are flexible, order is free):
//   vendor | end date (YYYY-MM-DD or DD/MM/YYYY) | notice days | owner | page (optional)

import { parseDate, formatDate } from './dates.js';

export const MAX_ROWS = 100;

const HEADERS = {
  vendor: /^(vendor|supplier|provider|vendor name|company)$/i,
  endDate: /^(end date|end|expiry|expiry date|expiration|expiration date|term end|contract end|renewal date)$/i,
  noticeDays: /^(notice days|notice|notice period|notice period \(days\)|notice \(days\)|days notice)$/i,
  owner: /^(owner|owner email|owner name|contract owner|business owner)$/i,
  confluenceUrl: /^(page|confluence|confluence page|confluence url|page url|contract page|link)$/i,
};

// One CSV/TSV line into cells, honouring "quoted, cells" and "" escapes.
export function splitLine(line, delim) {
  if (delim === '\t') return line.split('\t').map((c) => c.trim());
  const cells = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// YYYY-MM-DD or DD/MM/YYYY (also DD.MM.YYYY and DD-MM-YYYY) to ISO, or null.
export function normaliseDate(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return parseDate(s) === null ? null : s;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const ms = Date.UTC(y, mo, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null;
  return formatDate(ms);
}

export const dupKey = (vendor, endDate) => `${String(vendor || '').trim().toLowerCase().replace(/\s+/g, ' ')}|${endDate}`;

// existing: agreements already tracked ({ vendor, endDate }), for duplicate detection.
export function parseImport(text, existing = []) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '');
  if (!lines.length) return { ok: false, error: 'Paste at least a header row and one agreement row.', rows: [] };
  const delim = lines[0].includes('\t') ? '\t' : lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const header = splitLine(lines[0], delim);
  const col = {};
  header.forEach((h, i) => {
    for (const [k, re] of Object.entries(HEADERS)) if (col[k] === undefined && re.test(h.trim())) col[k] = i;
  });
  const missingCols = ['vendor', 'endDate', 'noticeDays'].filter((k) => col[k] === undefined);
  if (missingCols.length) {
    return {
      ok: false,
      error: `The header row needs columns for vendor, end date and notice days (missing: ${missingCols
        .map((k) => ({ vendor: 'vendor', endDate: 'end date', noticeDays: 'notice days' })[k])
        .join(', ')}).`,
      rows: [],
    };
  }

  const seen = new Set(existing.map((a) => dupKey(a.vendor, a.endDate)));
  const inPaste = new Set();
  const body = lines.slice(1);
  const rows = body.map((line, i) => {
    const cells = splitLine(line, delim);
    const get = (k) => (col[k] === undefined ? '' : (cells[col[k]] ?? '').trim());
    const row = {
      line: i + 2,
      vendor: get('vendor'),
      endDateRaw: get('endDate'),
      endDate: normaliseDate(get('endDate')),
      noticeDaysRaw: get('noticeDays'),
      noticeDays: null,
      owner: get('owner'),
      confluenceUrl: get('confluenceUrl') || null,
      errors: [],
      duplicate: null,
    };
    if (i >= MAX_ROWS) {
      row.errors.push(`Over the ${MAX_ROWS}-row limit. Import the rest in another paste.`);
      return row;
    }
    if (!row.vendor) row.errors.push('Vendor is empty.');
    if (!row.endDateRaw) row.errors.push('End date is empty.');
    else if (!row.endDate) row.errors.push(`End date "${row.endDateRaw}" is not a valid YYYY-MM-DD or DD/MM/YYYY date.`);
    const n = Number(row.noticeDaysRaw);
    if (row.noticeDaysRaw === '') row.errors.push('Notice days is empty.');
    else if (!Number.isInteger(n) || n < 0 || n > 3650) row.errors.push(`Notice days "${row.noticeDaysRaw}" must be a whole number of days.`);
    else row.noticeDays = n;
    if (row.confluenceUrl && !/^https:\/\/\S+$/i.test(row.confluenceUrl)) row.errors.push('Page must be an https link to the Confluence page.');
    if (!row.errors.length) {
      const k = dupKey(row.vendor, row.endDate);
      if (seen.has(k)) row.duplicate = 'Already tracked (same vendor and end date).';
      else if (inPaste.has(k)) row.duplicate = 'Repeated earlier in this paste.';
      inPaste.add(k);
    }
    return row;
  });
  const valid = rows.filter((r) => !r.errors.length && !r.duplicate).length;
  return {
    ok: true,
    delimiter: delim === '\t' ? 'tab' : delim === ',' ? 'comma' : 'semicolon',
    rows,
    counts: {
      total: rows.length,
      valid,
      duplicates: rows.filter((r) => r.duplicate).length,
      invalid: rows.filter((r) => r.errors.length).length,
    },
    truncated: body.length > MAX_ROWS,
  };
}
