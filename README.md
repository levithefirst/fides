<p><img src="assets/brand/fides-logo-128.png" alt="Fides logo" width="64" height="64"></p>

# Fides

**Fides connects what an agreement promises to what is actually blocking it, and escalates before the notice window closes.**

Fides (FY-deez) is a Forge app for Jira, Confluence and Rovo. It is for legal, procurement, finance, ITAM/SAM and ops teams who already work in Jira and Confluence and who track vendor and SaaS agreements in a spreadsheet, a calendar reminder, or not at all.

Codegeist 2026 · Track: **Apps for Business Teams** · Bonus: **Best Agents** (`rovo:agent` + four `action` modules)

> Fides tracks dates and obligations; it is not legal advice.

## What it does

- Each vendor agreement is a **Jira issue** (labelled `fides-agreement`), linked to its **Confluence contract page**, with structured end date, notice period, spend, owner and key obligations.
- Fides computes the **notice-by date** (end date minus notice period) and shows a **notice board** with three labelled statuses:
  - **Due**: notice-by within 14 days, today, or already past (filled diamond).
  - **Upcoming**: 15 to 60 days (half-filled square).
  - **On track**: more than 60 days (empty ring).
- A **blocker** is a linked Jira issue for an open question, a pending approval or an unmet deliverable (labelled `fides-blocker`). If a blocker is still open while the notice-by or milestone date is Due, Fides creates **exactly one escalation issue** for that agreement and blocker. It links the agreement, the blocker and the contract page, and says in hedged words that the blocker "may put the notice date of DD MMM at risk".
- A daily `scheduledTrigger` (running with `api.asApp()`) opens review issues when the notice window starts, pings them when the date is reached, and runs the escalation rule. Errors are caught and the last run is shown on the board.
- A **Rovo agent with actions** does the work in chat, as the current user and with their permissions.

## What it is not

Not a CLM, not a contract-approval router, not a jargon translator, not a budget dashboard. No document upload or PDF extraction. Spend is shown for context only.

## Rovo agent: four actions, front and centre

The board's **Ask Fides in Rovo** panel opens Rovo Chat with the Fides agent and a ready prompt for each action.

| Action key | Verb | What it does |
| --- | --- | --- |
| `list-upcoming-notices` | `GET` | Lists agreements that are Due or fall within the next N days (default 60), most urgent first, using the same rule as the board. Only issues the user can see. |
| `create-review-issue` | `CREATE` | Creates (or returns the open) review issue for one agreement on the **current** site, linked to the agreement. No hardcoded IDs. |
| `escalate-threatened-milestones` | `CREATE` | Applies the escalation rule to one or all agreements. Idempotent: reports existing escalations instead of duplicating them. |
| `draft-brief` | `GET` | Gathers a hedged renew / cancel / renegotiate brief: timing, open blockers, options, what a missed notice could mean, and quoted excerpts from the linked Confluence page read **as the user**. If the user cannot read the page, it says so and continues from stored obligations. |

The agent prompt (`static/agent/prompt.txt`) tells it to use only action data, hedge every statement, use the word "blocker" for open questions, approvals and deliverables, and end decision answers with the not-legal-advice line.

## How it maps to the judging criteria

| Criterion (20% each) | How Fides meets it | Atlassian features used |
| --- | --- | --- |
| **Technological Implementation** | A real loop, not a single demo path: structured agreements, a shared status rule used by the board, scan and agent, idempotent escalation (KVS `FAIL_IF_EXISTS` claims plus Jira label guards), install-time and first-open seeding with a lock, permission-aware reads via bulk fetch, 28 tests in CI. | **Forge modules**: `jira:globalPage`, `jira:issuePanel`, `scheduledTrigger` (interval `day`, `api.asApp()`), `trigger` on `avi:forge:installed:app`, Key-Value Store (`@forge/kvs`). **Jira issues and links**: agreements, blockers, review and escalation issues, issue links, remote links. |
| **Design** | Native UI Kit, ADS tokens, light and dark themes, colourblind-safe chips (shape plus label), 30/60/90 grouping, last-scan status, recoverable empty and error states, one Fides Umber accent. Judge mode means the first screen already shows the product working. | UI Kit (`render: native`), ADS tokens, Rovo bridge `rovo.open` from the board. |
| **Potential Impact** | Missed notice periods and auto-renewals are a named value-leakage bucket (see Evidence). Fides puts the date, the obligation and the blocker in the tools these teams already use, and acts before the window closes. | **Jira issues** as the system of record, **Confluence contract pages** as the source of terms. |
| **Innovation / Idea** | Connects contract dates to live work: an open blocker issue threatening a notice date triggers a hedged escalation automatically and through the agent. | **Rovo agent + actions**: `rovo:agent` with four `action` modules (`GET`, `CREATE`). **Confluence**: contract pages read as the user for the brief. |
| **Presentation** | Zero-setup judge mode: install, open the board, see Due / Upcoming / On track and the escalation within 10 seconds. The demo script walks the full loop in under 5 minutes. | `trigger` (install), `jira:globalPage`, **`scheduledTrigger` with `api.asApp()`** shown via the last-scan line, Rovo Chat. |

## Judge setup (fresh site, zero manual steps)

1. Install Fides from the Sharing installation link on your site.
2. Open **Apps > Fides** in Jira.
3. **Judge mode** has already seeded, or seeds now (idempotently), on the current site:
   - four sample agreements with dates computed from today: Helios Payroll (**Due**), Larkspur Facilities and Northwind Analytics (**Upcoming**), Quay Support (**On track**);
   - sample Confluence contract pages, if Confluence is available to the app;
   - one open blocker on Helios Payroll ("Approval pending: finance sign-off ...");
   - the **escalation issue** for it, created immediately, not on the next daily run;
   - a review issue for the Due agreement.
4. The board shows all of this, plus the escalation message, within about 10 seconds.
5. Click any **Ask Fides in Rovo** button, or open Rovo Chat, choose **Fides** and try a conversation starter.

Notes:

- Seeding is safe to re-run and **skips when real data exists** (any `fides-agreement` issue without the `fides-sample` label, or any non-sample agreement in Fides). The **Load samples** button is an explicit request and seeds anyway, still without duplicates.
- Fides picks the first project on the site where it can create a standard issue type (Task, or the site's default). If there is none, the board shows a project picker.
- Rovo Chat must be enabled on the site. Classic `*-dev.atlassian.net` sites often lack it; use a site from `forge site provision`.
- If the app cannot use Confluence on your site, agreements and escalations still seed and the board offers **Link a page**.

## Developer setup

Requires **Node 22.x (22.23.4 or later) or 24.x (24.22.1 or later)**, per the live Forge getting-started page.

```bash
npm install -g @forge/cli@latest
npm ci
npm test                    # 28 unit and integration tests
npm run validate:manifest   # offline schema check with @forge/manifest
```

With `FORGE_EMAIL` and `FORGE_API_TOKEN` set in the environment (do not run `forge login` then, and never echo the token):

```bash
forge register              # first time only; replaces the placeholder app.id
forge deploy
forge install --demo-site
```

**After adding or changing scopes**, run `forge deploy` and then `forge install --upgrade` so the site grants the new scopes.

The full deploy, provisioning, Sharing and submission checklist is in [`docs/HANDOFF.md`](docs/HANDOFF.md).

## Architecture

```
manifest.yml
src/
  index.js            Forge handlers: UI resolver, install trigger, daily scan, 4 Rovo actions
  services.js         Core loop: agreements, blockers, review issues, escalation, scan, judge mode, board data
  lib/dates.js        Notice-by and Due / Upcoming / On track rules (single source of truth)
  lib/escalation.js   Blocker open check, RED window, idempotency keys, hedged wording
  lib/samples.js      Judge-mode sample agreements relative to today
  lib/brief.js        Hedged brief drafting and assistive page excerpts
  lib/atlassian.js    Documented Jira REST v3 and Confluence REST v2 calls
  lib/store.js        KVS layout and claims
  frontend/board.jsx  Notice board (jira:globalPage, UI Kit)
  frontend/panel.jsx  Issue panel (jira:issuePanel, UI Kit)
static/               Agent prompt and icon
test/                 node:test suites, including an offline judge-mode acceptance test
scripts/              Manifest validation and a live acceptance poll
```

- People-facing paths (board, panel, Rovo actions) use `api.asUser()`, so they respect Jira and Confluence permissions.
- Scheduled and install work uses `api.asApp()`, because scheduled triggers have no user.
- Agreement issues live in Jira; structured dates and obligations live in the Forge Key-Value Store keyed by issue id. No custom issue type or custom field is needed. No external hosting.

## Scopes

| Scope | Why |
| --- | --- |
| `read:jira-work` | Read agreements, blockers, links; search; bulk fetch |
| `write:jira-work` | Create agreement, blocker, review and escalation issues; links; comments |
| `storage:app` | Key-Value Store |
| `read:page:confluence` | Read the contract page for the brief; find sample pages |
| `write:page:confluence` | Create sample contract pages in judge mode |
| `read:space:confluence` | Pick a space for sample pages |

## Evidence

Only these figures are cited:

- World Commerce & Contracting with Ironclad, *Closing the Procurement Value Gap* (2026): organisations lose an average of **11% of contract value** after signature, including **2 to 3%** in renewal costs from poor forward planning ("auto-renewals at unfavourable terms, missed notice periods, and reactive renegotiation") and **1 to 2%** in penalties and disputes from missed obligations. Caveat: the report was produced with a CLM vendor and the 11% methodology is not fully public. An earlier WorldCC/Deloitte (2023) figure was 8.6% average leakage, self-reported. Sources: [report PDF](https://www.worldcc.com/static/88fffe38-ee53-49da-904c696d0030219d/Procurement-value-gap.pdf), [landing page](https://info.worldcc.com/closing-the-procurement-value-gap).
- Flexera *2023 Tech Spend Pulse*: an estimated **21% of SaaS spend wasted**. Flexera *State of IT Asset Management* (Oct 2022): only **43%** of SAM teams tracked and managed SaaS auto-renewal clauses.

## Acceptance

- [x] `docs/SDK-NOTES.md` pins Node, CLI and runtime from live docs and names official module keys (no invented keys).
- [ ] `forge deploy` succeeds. **Blocked**: no credentials or provisioned site in the build session; see `docs/HANDOFF.md`.
- [ ] `forge install --demo-site` succeeds. **Blocked**, same reason.
- [x] Load samples / judge mode seeds the current site (Due, Upcoming, On track) with no hardcoded site, project or issue IDs. *(Verified offline; confirm live.)*
- [x] Notice board shows Due / Upcoming / On track with shapes and labels, 30/60/90 grouping, last-scan status and the footer. *(Built; confirm live.)*
- [x] Issue panel shows status on agreement, review, blocker and escalation issues. *(Built; confirm live.)*
- [ ] Rovo agent is visible in Rovo Chat. **Pending live site.**
- [ ] `list-upcoming-notices` returns the samples. **Pending live site.**
- [ ] `create-review-issue` creates a real Jira issue on the current site. **Pending live site.**
- [ ] `escalate-threatened-milestones` reports the judge-mode escalation and never duplicates. **Pending live site.**
- [ ] `draft-brief` is permission-aware and uses the linked page when readable. **Pending live site.**
- [x] Daily `scheduledTrigger` (`interval: day`) is in the manifest and wired; errors are caught; last run is visible.
- [x] Unit tests for date and status rules, the RED window, blocker open/closed and idempotency pass in CI.
- [ ] Judge mode: seeded board plus escalation visible in under 10 seconds after a fresh install. **Offline simulation passes (about 4.4 s at 400 ms per call); live test in `docs/HANDOFF.md` step 8 pending.**
- [x] README, LICENSE (Apache-2.0), DEMO-SCRIPT.md, SUBMISSION-DRAFT.md, docs/HANDOFF.md, docs/COLOR-THEME.md present.
- [x] No API tokens or debug credentials in git.
- [x] Repo left private. No Devpost submission. No video upload.

## License

Apache-2.0. See [LICENSE](LICENSE).

---

Fides tracks dates and obligations; it is not legal advice.
