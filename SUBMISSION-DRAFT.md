# Devpost submission draft (for Fluid to paste)

Fluid submits. No agent submits or posts. Deadline: **Tue 22 Dec 2026, 9:00 PM WAT** (3:00 PM EST).

The field-by-field paste copy (with the Sharing link filled) lives on the box at `/workspace/hackathon-ideas/codegeist2026/devpost-fields.md`. This file stays in the private repo and must not contain the Sharing URL.

Live product (keys are for the demo site, not a judge install): production **3.2.0** (169 tests, `forge lint` clean) on `one-atlas-wptq.atlassian.net`. Board: **1 Due / 2 Upcoming / 1 On track**. Helios Payroll CLSD-35 (Due, notice-by 2026-11-24, end 2026-12-24, blocker CLSD-39, escalation CLSD-40, review CLSD-41); Northwind Analytics CLSD-36 (notice-by 2027-01-02); Larkspur Facilities CLSD-37 (notice-by 2026-12-13, review CLSD-45); Quay Support CLSD-38 (notice-by 2027-03-18). Highest key: CLSD-45.

---

**Title:** Fides

**Tagline:** From signed to delivered

**Elevator pitch (if the form has a second short field; 121 characters, under the typical 200-character Devpost limit):** Fides connects what an agreement promises to what is actually blocking it, and escalates before the notice window closes.

**Category:** Apps for Business Teams

**Bonus prize:** Best Agents (Forge app with a `rovo:agent` module and six `action` modules)

**Installation link:** `[FORGE-SHARING-LINK]`

**Demo video:** `[YOUTUBE-URL]`

## Inspiration / problem

Vendor and SaaS agreements renew automatically, or their obligations never reach the team that has to meet them. Legal, procurement, finance and ops teams track notice dates in spreadsheets and calendar reminders, and the decision stalls on something small: an approval nobody gave, a question nobody answered.

World Commerce & Contracting with Ironclad (*Closing the Procurement Value Gap*, 2026) estimates organisations lose an average of 11% of contract value after signature, and names auto-renewals at unfavourable terms and missed notice periods among the causes. The report was produced with a CLM vendor and its methodology is not fully public. Flexera's 2023 Tech Spend Pulse estimated 21% of SaaS spend is wasted, and its State of IT Asset Management (Oct 2022) found only 43% of SAM teams tracked and managed SaaS auto-renewal clauses.

## What it does

- Each agreement is a Jira issue linked to its Confluence contract page, with end date, notice period, spend, owner and key obligations.
- Fides computes the notice-by date and shows a notice board: **Due** (within 14 days or past), **Upcoming** (15 to 60 days), **On track** (over 60 days), each with a shape and a label, plus 30/60/90 day grouping.
- A blocker (an open question, a pending approval or an unmet deliverable) is a linked Jira issue. If it is still open when the notice date is Due, Fides creates exactly one escalation issue, linked to the agreement, the blocker and the contract page, saying the blocker "may put the notice date of DD MMM at risk".
- A daily scheduled trigger opens review issues and runs the escalation rule as the app.
- Jira is the source of truth: the `fides-agreement` issue property plus labels. Forge KVS is a per-install cache hydrated from Jira; an empty store never means "no agreements".
- The **Fides Rovo agent** works through six actions as the current user:
  1. **List upcoming notices** (`list-upcoming-notices`, GET), including open review and escalation keys so the agent can say whether a later confirm will reuse or create;
  2. **Create or reuse review issue** (`create-review-issue`, CREATE), never duplicates;
  3. **Create or reuse escalation** (`escalate-threatened-milestones`, CREATE), never duplicates;
  4. **Draft renew or cancel brief** (`draft-brief`, GET) from the Confluence page as the current user;
  5. **Check contract page** (`check-agreement-from-page`, GET), read-only, no confirm card;
  6. **Track agreement from page** (`track-agreement-from-page`, CREATE), only after the user confirms a proposal.
- Before a CREATE confirm card, the agent lists first and says in chat whether confirming will reuse or create.
- **Getting data in:** paste rows from a spreadsheet (preview with per-row errors, duplicates skipped, up to 100 rows), or track from a contract page.
- **Owners hear about it in Jira:** review and escalation issues are assigned to the agreement owner, who is also added as a watcher, so Jira's own notifications do the work. No custom email.
- **Fast and honest board:** paints from a per-user snapshot in under 3 seconds on a warm site, and every edge state (no Rovo, no Confluence, read-only user, zero agreements) shows one plain sentence and one next step.
- **Judge mode:** on install or first open, Fides seeds sample agreements, a blocker and the escalation on the current site, so the product is visibly working within about 10 seconds with zero setup. It never seeds over real data.

Fides tracks dates and obligations; it is not legal advice.

## How we built it (Forge and Rovo modules)

- `jira:globalPage` (UI Kit, native render): the notice board.
- `jira:issuePanel`: notice status on agreement, review, blocker and escalation issues.
- `scheduledTrigger` (`interval: day`) using `api.asApp()`, with caught errors and a visible last-run stamp.
- `trigger` on `avi:forge:installed:app` and `avi:forge:upgraded:app` for judge mode and page heals, with retry while app permissions propagate.
- `rovo:agent` **Fides** with six actions: `list-upcoming-notices` (List upcoming notices, GET), `create-review-issue` (Create or reuse review issue, CREATE), `escalate-threatened-milestones` (Create or reuse escalation, CREATE), `draft-brief` (Draft renew or cancel brief, GET), `check-agreement-from-page` (Check contract page, GET) and `track-agreement-from-page` (Track agreement from page, CREATE).
- Jira issue properties and labels as the source of truth. Forge Key-Value Store (`@forge/kvs`) as a per-install cache and for short-lived idempotency claims. No external hosting.
- Jira REST v3 (issues, links, remote links, JQL search, bulk fetch) and Confluence REST v2 (pages, spaces).

## Challenges

- Making escalation strictly idempotent across a daily trigger that may fire twice, an install trigger, a board open and the agent: KVS fail-if-exists claims plus a Jira label guard; a lost claim adopts the existing issue by label.
- App storage is per product install, so an empty Confluence-side store used to look like "no agreements." Jira properties and labels are now the source of truth.
- Naming the CREATE actions **Create or reuse review issue** and **Create or reuse escalation**, and having the agent list first, so the confirm card and the chat both say whether confirming will reuse or create.
- Seeding fast enough for a 10 second first impression: parallel discovery and escalating the just-created blocker directly.
- Keeping every statement hedged, with "Fides tracks dates and obligations; it is not legal advice." on every brief and screen.

## Accomplishments

- One status rule shared by the board, the scan and the agent, with boundary tests (today, past, 14/15, 60/61, leap years).
- A permission-aware agent that says plainly when it cannot read a contract page.
- On the live demo site, a second review or escalation request reuses the open issue (Helios review CLSD-41, Larkspur review CLSD-45, Helios escalation CLSD-40) instead of opening a duplicate.
- Production 3.2.0: 169 tests, `forge lint` clean. Clean install tested on a new Free site.

## What's next

Obligation reminders beyond notice dates, and per-project boards.

## Judge setup

1. Install from the Sharing link on a site where you are an admin, for both Jira and Confluence (the link offers both).
2. Open **Apps > Fides** in Jira. Sample agreements load automatically on install or on this first open; there is no button to press. Within about ten seconds the board shows **1 Due** (Helios Payroll, with one open blocker and one escalation issue), **2 Upcoming** and **1 On track**, each linked to a sample Confluence contract page. If your Confluence has no space yet (a new Free site starts with none), Fides creates one called **Fides contracts** for the sample pages.
3. Use the **Ask Fides in Rovo** buttons on the board, or open Rovo and choose **Fides**. If Jira has no Ask Rovo button (for example on Jira Free), go to **home.atlassian.com**, choose **Agents**, then **Fides**. **List upcoming notices** also shows the list right on the board, with or without Rovo.
4. Try the six actions: **List upcoming notices**, **Create or reuse review issue**, **Create or reuse escalation**, **Draft renew or cancel brief**, **Check contract page** and **Track agreement from page**. Asking a second time for a review or an escalation reuses the open issue instead of creating a duplicate.

Two **Fides** entries in the Rovo agent picker are expected, one per product install. Both give the same answers, because Fides reads everything from Jira.

## Built with

Forge, UI Kit, Rovo, Jira Cloud, Confluence Cloud, Node.js 24
