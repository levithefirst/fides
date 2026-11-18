# Devpost submission draft (for Fluid to paste)

Fluid submits. No agent submits or posts. Deadline: **Tue 22 Dec 2026, 9:00 PM WAT** (3:00 PM EST).

---

**Title:** Fides

**Tagline:** Fides connects what an agreement promises to what is actually blocking it, and escalates before the notice window closes.

**Category:** Apps for Business Teams

**Bonus prize:** Best Agents (Forge app with a `rovo:agent` module and four `action` modules)

**Installation link:** `<SHARING INSTALL LINK>`

**Demo video:** `<PUBLIC YOUTUBE URL>`

## Inspiration / problem

Vendor and SaaS agreements renew automatically, or their obligations never reach the team that has to meet them. Legal, procurement, finance and ops teams track notice dates in spreadsheets and calendar reminders, and the decision stalls on something small: an approval nobody gave, a question nobody answered.

World Commerce & Contracting with Ironclad (*Closing the Procurement Value Gap*, 2026) estimates organisations lose an average of 11% of contract value after signature, and names auto-renewals at unfavourable terms and missed notice periods among the causes. The report was produced with a CLM vendor and its methodology is not fully public. Flexera's 2023 Tech Spend Pulse estimated 21% of SaaS spend is wasted, and its State of IT Asset Management (Oct 2022) found only 43% of SAM teams tracked and managed SaaS auto-renewal clauses.

## What it does

- Each agreement is a Jira issue linked to its Confluence contract page, with end date, notice period, spend, owner and key obligations.
- Fides computes the notice-by date and shows a notice board: **Due** (within 14 days or past), **Upcoming** (15 to 60 days), **On track** (over 60 days), each with a shape and a label, plus 30/60/90 day grouping.
- A blocker (an open question, a pending approval or an unmet deliverable) is a linked Jira issue. If it is still open when the notice date is Due, Fides creates exactly one escalation issue, linked to the agreement, the blocker and the contract page, saying the blocker "may put the notice date of DD MMM at risk".
- A daily scheduled trigger opens review issues and runs the escalation rule as the app.
- The **Fides Rovo agent** works through five actions as the current user: list upcoming notices, create a review issue, escalate threatened milestones, draft a hedged renew / cancel / renegotiate brief from the Confluence page, and track an agreement straight from its Confluence contract page (a proposal with quoted sources, created only after the user confirms).
- **Getting data in:** paste rows from a spreadsheet (preview with per-row errors, duplicates skipped, up to 100 rows), or track from a contract page.
- **Owners hear about it in Jira:** review and escalation issues are assigned to the agreement owner, who is also added as a watcher, so Jira's own notifications do the work. No custom email.
- **Fast and honest board:** paints from a per-user snapshot in under 3 seconds on a warm site, and every edge state (no Rovo, no Confluence, read-only user, zero agreements) shows one plain sentence and one next step.
- **Judge mode:** on install or first open, Fides seeds sample agreements, a blocker and the escalation on the current site, so the product is visibly working within about 10 seconds with zero setup. It never seeds over real data.

Fides tracks dates and obligations; it is not legal advice.

## How we built it (Forge and Rovo modules)

- `jira:globalPage` (UI Kit, native render): the notice board.
- `jira:issuePanel`: notice status on agreement, review, blocker and escalation issues.
- `scheduledTrigger` (`interval: day`) using `api.asApp()`, with caught errors and a visible last-run stamp.
- `trigger` on `avi:forge:installed:app` for judge mode, with retry while app permissions propagate.
- `rovo:agent` **Fides** with actions `list-upcoming-notices` (GET), `create-review-issue` (CREATE), `escalate-threatened-milestones` (CREATE), `draft-brief` (GET) and `track-agreement-from-page` (CREATE).
- Forge Key-Value Store (`@forge/kvs`) for structured dates, idempotency claims and state. No external hosting.
- Jira REST v3 (issues, links, remote links, JQL search, bulk fetch) and Confluence REST v2 (pages, spaces).

## Challenges

- Making escalation strictly idempotent across a daily trigger that may fire twice, an install trigger, a board open and the agent: KVS fail-if-exists claims plus a Jira label guard.
- Seeding fast enough for a 10 second first impression: parallel discovery and escalating the just-created blocker directly.
- Keeping every statement hedged, with "Fides tracks dates and obligations; it is not legal advice." on every brief and screen.

## Accomplishments

- One status rule shared by the board, the scan and the agent, with boundary tests (today, past, 14/15, 60/61, leap years).
- A permission-aware agent that says plainly when it cannot read a contract page.

## What's next

Obligation reminders beyond notice dates, and per-project boards.

## Judge setup

1. Install from the Sharing link.
2. Open **Apps > Fides** in Jira. Sample agreements, a blocker and an escalation appear automatically.
3. Use the **Ask Fides in Rovo** buttons or open Rovo Chat and pick **Fides**. Rovo Chat must be enabled on the site.

## Built with

Forge, UI Kit, Rovo, Jira Cloud, Confluence Cloud, Node.js 24
