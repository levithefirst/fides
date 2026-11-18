// Judge-mode sample agreements. Dates are computed from `today`, so the
// buckets never go stale: whenever a judge installs, Helios Payroll is Due
// with an open blocker, Larkspur and Northwind are Upcoming, Quay is On track.
// Vendor names are invented and are not real trademarks.

import { addDays, noticeByDate } from './dates.js';

export const SAMPLE_VERSION = 1;

const DEFS = [
  {
    sampleKey: 'helios',
    vendor: 'Helios Payroll',
    noticeDays: 30,
    noticeInDays: 6, // RED: notice-by within 14 days
    spend: 'USD 48,000 / year',
    owner: 'People Ops',
    obligations:
      'Auto-renews for 12 months unless written notice is given 30 days before the end date. Price uplift capped at 5%. Quarterly payroll accuracy report owed by the vendor.',
    blocker: {
      summary: 'Approval pending: finance sign-off on Helios Payroll renewal terms',
      description:
        'Finance has not yet approved the proposed renewal terms. Until this approval lands the team cannot decide whether to renew, renegotiate or give notice.',
    },
  },
  {
    sampleKey: 'larkspur',
    vendor: 'Larkspur Facilities',
    noticeDays: 60,
    noticeInDays: 25, // AMBER, inside the 30-day window
    spend: 'USD 12,500 / year',
    owner: 'Workplace',
    obligations:
      'Cleaning and maintenance for two offices. 60 days notice to cancel. Vendor must provide proof of insurance each contract year.',
  },
  {
    sampleKey: 'northwind',
    vendor: 'Northwind Analytics',
    noticeDays: 90,
    noticeInDays: 45, // AMBER, inside the 60-day window
    spend: 'USD 96,000 / year',
    owner: 'Data Platform',
    obligations:
      'Seat-based analytics licence, 120 seats. 90 days notice for non-renewal. True-up of seat count due at each anniversary.',
  },
  {
    sampleKey: 'quay',
    vendor: 'Quay Support',
    noticeDays: 30,
    noticeInDays: 120, // GREEN
    spend: 'USD 30,000 / year',
    owner: 'Customer Success',
    obligations:
      'Tier-2 support desk outsourcing. 30 days notice. Monthly SLA report owed by the vendor; service credits apply below 95% SLA.',
  },
];

export function buildSamples(today) {
  return DEFS.map((d) => {
    const noticeBy = addDays(today, d.noticeInDays);
    const endDate = addDays(noticeBy, d.noticeDays);
    // Sanity: the computed notice-by must round-trip.
    if (noticeByDate(endDate, d.noticeDays) !== noticeBy) throw new Error('sample date drift');
    return {
      sampleKey: d.sampleKey,
      vendor: d.vendor,
      endDate,
      noticeDays: d.noticeDays,
      spend: d.spend,
      owner: d.owner,
      obligations: d.obligations,
      blocker: d.blocker || null,
      sample: true,
    };
  });
}

export function samplePageTitle(vendor) {
  return `Fides sample contract: ${vendor}`;
}

export function samplePageBody(s) {
  // Confluence storage format. Kept simple and clearly marked as sample data.
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    '<p><strong>Sample data created by Fides judge mode.</strong> Safe to delete.</p>',
    '<table><tbody>',
    `<tr><th>Vendor</th><td>${esc(s.vendor)}</td></tr>`,
    `<tr><th>End date</th><td>${esc(s.endDate)}</td></tr>`,
    `<tr><th>Notice period</th><td>${esc(s.noticeDays)} days</td></tr>`,
    `<tr><th>Spend</th><td>${esc(s.spend)}</td></tr>`,
    `<tr><th>Owner</th><td>${esc(s.owner)}</td></tr>`,
    '</tbody></table>',
    '<h2>Key obligations</h2>',
    `<p>${esc(s.obligations)}</p>`,
    '<h2>Termination and renewal</h2>',
    `<p>This agreement expires on ${esc(s.endDate)} and renews automatically for a further 12 months.</p>`,
    `<p>Either party may terminate by giving ${esc(s.noticeDays)} days' written notice before the end date.</p>`,
  ].join('');
}
