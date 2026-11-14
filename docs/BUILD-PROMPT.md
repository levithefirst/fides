# Fides — one Claude Code prompt (scratch to submission-ready)

**How to use.** Open the private GitHub repo `levithefirst/fides` in Claude Code on the web (Pixel-friendly). Paste everything below the horizontal rule, once. Your job is to take an empty repo to a submission-ready Forge app in this session: manifest, in-product UI, scheduled trigger, Rovo agent and actions, tests, sample loader, README, license, demo and submission drafts, and a handoff file for everything you cannot do from this environment.

Keep the repo **private**. Do not open a PR that changes visibility. Do not submit to Devpost, upload a YouTube video, print secrets, or use the address `leviweb3x@gmail.com` anywhere.

If `docs/COLOR-THEME.md` is not already in the repo, recreate it from the theme rules in this prompt (Fides Umber `#77441A` / `#E0AB86`, ADS tokens for everything else, colourblind status chips).

---

You are Claude Code. Build **Fides**, a Codegeist 2026 Forge app, from this empty repository to a submission-ready product. Do not stop at a scaffold. Do not invent Forge module names, CLI flags, REST paths, GraphQL fields, or pain-point statistics. If typings or live official docs disagree with this brief, follow the live docs and record the difference in `docs/SDK-NOTES.md`.

## Product

Fides is for legal, procurement, finance, ITAM/SAM, and ops teams who already work in Jira and Confluence. Vendor and SaaS agreements auto-renew, or negotiated obligations never reach the team that has to live them. Today that process is a spreadsheet, a calendar reminder, or nothing.

Each vendor agreement is a structured Jira work item linked to its Confluence contract page (end date, notice period, spend, owner, key obligations). The app computes the **notice-by date** (end date minus notice period in days) and shows a notice board with three labelled statuses. A daily `scheduledTrigger` opens or pings a review issue when the notice window starts. A Rovo agent, using actions (not chat-for-chat’s-sake), can list what comes due in the next 60 days, create and assign the review issue on the **current** site, and draft a renew / cancel / renegotiate brief from the linked page — permission-aware, as the current user.

This is not a CLM, not a contract-approval router, not a jargon translator, and not a budget dashboard. Do not look like Budgety (spend charts, CAPEX/OPEX, money-green analytics). Do not add `rovo:mcp`, `rovo:agentConnector`, or `graph:connector`. Do not use Teamwork Graph. Track: Apps for Business Teams. Bonus: Best Agents (`rovo:agent` + action modules).

**Pain-point evidence you may cite** (in README, DEMO-SCRIPT, SUBMISSION-DRAFT only — these are the only verified figures; do not invent or “round up”):

- World Commerce & Contracting with Ironclad, *Closing the Procurement Value Gap* (2026): organisations lose an average of **11% of contract value** after signature. Two slices map to this product: **renewal costs from poor forward planning, 2–3%** (the report names “auto-renewals at unfavourable terms, missed notice periods, and reactive renegotiation”) and **penalties and disputes from missed obligations, 1–2%**. Caveat, do not hide it: the report was produced with a CLM vendor; the 11% methodology is not fully public. An earlier WorldCC/Deloitte 2023 figure was 8.6% average leakage, self-reported. “Missed notice periods / auto-renewals” is an explicit WorldCC leakage bucket. Sources: `https://www.worldcc.com/static/88fffe38-ee53-49da-904c696d0030219d/Procurement-value-gap.pdf` and `https://info.worldcc.com/closing-the-procurement-value-gap`.
- Flexera *2023 Tech Spend Pulse*: estimated **21% of SaaS spend wasted**. Flexera *State of IT Asset Management*, Oct 2022: only **43%** of SAM teams tracked and managed SaaS auto-renewal clauses. Sources: Flexera’s 2023 Tech Spend Pulse press page and the Oct 2022 ITAM report PDF.

**Do not use:** “WorldCC 2024, 68% of enterprises report 7+ day delays in contract approvals”; “80% of Fortune 500 use Confluence for legal docs (Atlassian 2023).” Both are unverified.

Name is **Fides** (FY-deez). Do not rename. Pronunciation can appear once in the README.

Deadline for the human submission (not yours): **Tue 22 Dec 2026, 9:00 PM Africa/Lagos (WAT)**. Event: `https://codegeist2026.devpost.com/`.

## Guardrails

- Never print, log, commit, or write into the repo: API tokens, `.env` values, App Check or debug tokens, wallet seeds, or the address `leviweb3x@gmail.com`.
- Atlassian account for this project is `memequant@mail.grokbot.com` only. Mentions of the account in `docs/HANDOFF.md` are fine. It must not appear as a hardcoded demo user in app code or sample data.
- Do not run `forge login` if `FORGE_EMAIL` and `FORGE_API_TOKEN` are already set. If you must talk about the token, refer to the secret name `FORGE_API_TOKEN` only.
- Do not `forge site provision` unless asked in a later session and credentials are present; that step is documented in `docs/HANDOFF.md`.
- Do not make this GitHub repository public. Do not submit to Devpost. Do not upload or publish a video.
- No Vercel, Railway, Neon, or other external host. Prefer Forge-hosted storage and in-product UI.
- No hardcoded demo-site hostnames, project keys, issue IDs, or cloud IDs. Judges install on **their** site via a Sharing link.
- Official Codegeist Resources may still say “Node.js 20+”. That is out of date. Live Forge getting-started (updated 26 Aug 2026) requires **Node 22.x (22.23.4 or later) or 24.x (24.22.1 or later)**. Node 20 reached end-of-life on 30 April 2026. Use `app.runtime.name: nodejs24.x` unless live docs specify a different current example. Record the live runtime and CLI versions in `docs/SDK-NOTES.md`.

## Phase 0 — Re-verify live docs (do this first, then continue)

Re-open and follow, in this order. Quote live names when they differ from this brief.

1. `https://developer.atlassian.com/platform/forge/getting-started/`
2. `https://developer.atlassian.com/platform/forge/provision-a-demo-development-site/`
3. `https://developer.atlassian.com/platform/forge/cli-reference/login/`
4. `https://developer.atlassian.com/platform/forge/build-a-hello-world-app-in-jira/`
5. `https://developer.atlassian.com/platform/forge/build-a-hello-world-rovo-agent/`
6. `https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/`
7. `https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-action/`
8. `https://developer.atlassian.com/platform/forge/manifest-reference/modules/scheduled-trigger/`
9. `https://developer.atlassian.com/platform/forge/manifest-reference/modules/index-jira/`
10. `https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-global-page/`
11. `https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-project-page/`
12. `https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-issue-panel/`
13. `https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-issue-context/`
14. `https://developer.atlassian.com/platform/forge/storage-reference/kvs/`
15. `https://developer.atlassian.com/platform/forge/manifest-reference/scopes-forge/`
16. Current Jira Cloud REST and Confluence Cloud REST docs for issue create/get and page body fetch (do not invent paths).
17. Atlassian Design tokens if you need to confirm a token name: `https://atlassian.design/components/tokens/all-tokens`

Write `docs/SDK-NOTES.md` with:

- `node -v` target: 22.23.4+ or 24.22.1+ (live getting-started wins).
- `@forge/cli` pinned to latest at build time; `forge --version` when you can run it.
- The runtime name you set (`nodejs24.x` or the live documented equivalent).
- The official Jira module keys you will use for the notice board, chosen from the live Jira modules index. Expected candidates, not inventions: `jira:globalPage` (Apps section of main navigation, site-level board — prefer this as the primary board so agreements are not trapped in one project) and/or `jira:projectPage` (project tab, filtered to that project). **Do not invent `jira:globalSidebar` or any other unlisted key.** Confirm `jira:issuePanel` and/or `jira:issueContext` (context requires `title` and `label` per live docs).
- Official storage package and scope (expected: `@forge/kvs` and `storage:app` — confirm live names).
- Official Rovo module keys and `actionVerb` values you will use (expected verbs include `GET` and `CREATE`; confirm on the live action module page).
- That `scheduledTrigger` allowed intervals are `fiveMinute`, `hour`, `day`, `week`; at most five triggers; the function runs **without a user context**; thrown errors are not retried; start is about five minutes after deploy.
- Whether a provisioned demo site is already available in this environment (if not, write that provision/deploy/install are blocked on the human / Grok Bot steps in `docs/HANDOFF.md` and do not fake a site).
- Any typings or path discrepancies.

Then scaffold from an official `forge create` template (Jira UI Kit and/or the official Rovo agent template). Prefer UI Kit with `render: native`. Keep the official project shape (`manifest.yml`, `src/`, resources) and replace the hello-world content. Add a `.nvmrc` or `engines` field that matches the Node requirement.

## Stack and manifest

- Runtime: `nodejs24.x` or live equivalent.
- UI: UI Kit native. If a surface truly requires Custom UI, say so in SDK-NOTES and still use ADS tokens.
- Storage: official Key-Value Store (`@forge/kvs`, `storage:app`) for agreement records, selected project key, and last-run stamp. Agreement issues still live in Jira.
- Product fetch: official `@forge/api` (`api.asUser().requestJira` / `requestConfluence` as documented). Scheduled work uses `api.asApp()` because scheduled triggers have no user principal. If a REST path is not in the current docs, write UNKNOWN, look it up, and do not invent one.
- Scopes: only what the live scopes page requires for issue read/write, app storage, and Confluence page read (for the brief action). After adding scopes, document the upgrade-install step in the README.
- Modules to include:
  - Site-level notice board via the official key recorded in SDK-NOTES (prefer `jira:globalPage`).
  - Optional `jira:projectPage` filtered to the current project.
  - `jira:issuePanel` and/or `jira:issueContext` on agreement and review issues, showing notice status, notice-by date, and a link to the Confluence page.
  - `scheduledTrigger` with `interval: day` calling a function that scans stored agreements and, when a notice-by date is reached and no open review exists, creates or comments/pings a review issue. Store a last-run stamp (ok or error). Catch all errors; do not throw. Make last-run visible on the board. A 24-hour wait is not required if a documented manual invoke path (for example a temporary `webTrigger` used only in development, or a clearly documented `forge` invoke if live CLI supports it) proves the function runs. Remove any dev-only trigger before calling the app submission-ready, or guard it so judges never see it.
  - `rovo:agent` with key, name **Fides** (name ≤ 30 characters), a tight prompt, conversation starters, and `actions` listing at least:
    1. `list-upcoming-notices` — `actionVerb` GET (confirm live) — returns agreements in the notice window (default next 60 days; honour the same Due / Upcoming / On track rules as the board).
    2. `create-review-issue` — creates (or assigns) a Jira review issue for a chosen agreement on the **current** site. No hardcoded IDs.
    3. `draft-brief` (or `draft-renewal-brief`) — input is an agreement id or linked Confluence page id. Fetch the page as the current user. Draft a short renew / cancel / renegotiate brief from the page plus stored obligations. If the user cannot read the page, return a clear permission error, not a stack trace. This must remain an action the agent invokes.
  - App icon slots the live manifest requires. If a final logo SVG is not in the repo yet, use a simple geometric placeholder that matches the theme (a taut bar with a notch, Fides Umber) and note the swap in HANDOFF.

## Data and rules

Store per agreement: vendor name, end date (`YYYY-MM-DD`), notice period in days, spend (display only; not a dashboard metric), owner, linked Confluence page id or URL, key obligations (short text), and the Jira issue id once created.

- Notice-by = end date minus notice period.
- **Due** (internal RED): notice-by is today, within 14 days, or already past.
- **Upcoming** (internal AMBER): 15–60 days.
- **On track** (internal GREEN): more than 60 days.
- Keep this definition consistent in the UI, the scheduled job, and `list-upcoming-notices`.

Agreements are real Jira issues of a **standard issue type discovered at runtime** (Task or the site’s default), labelled `fides-agreement`. Review issues are labelled `fides-review` and linked to the agreement issue. Do not require a custom issue type or a custom field the judge would have to create. Dates and obligations may live in KVS keyed by issue id and/or official entity properties — follow live docs; do not invent an indexing module.

**Load sample agreements** on the board:

- Discovers or asks for a project on the **current** site (project picker; persist the choice in KVS). Never hardcode a project key.
- Seeds at least three agreements whose dates are computed from **today**, so the buckets never go stale: one already Due, one Upcoming, one On track.
- Uses invented vendor names that are not real trademarks (for example Northwind Analytics, Helios Payroll, Quay Support). Do not use Ironclad, Juro, Vendr, Zylo, Spendflo, Budgety, or Atlassian as sample vendors.
- Creates or reuses a clearly marked sample Confluence page on the current site if the user’s permissions allow; if Confluence write is not in scope or fails, still seed agreements and show a recoverable “link a page” empty state for the brief action.
- Is idempotent enough to run twice without filling the site with duplicates (match on a sample key stored in KVS or an entity property).

Visible footer on the board, the issue panel, and agent-facing errors where relevant: **“Fides tracks dates and obligations; it is not legal advice.”** Do not claim a live statute or “you must cancel this contract.” Hedge.

## UI and colour theme (world-class, not slop)

The app must feel like a native Jira app with Linear-level restraint: typographic, exact, not a gadget and not a finance dashboard.

- Use `@atlaskit/tokens` (`token()`) and UI Kit components for surfaces, text, borders, elevation, spacing, and status tints. Inherit the host light and dark themes. Never hard-code Neutral greys.
- **One brand accent, Fides Umber:** `#77441A` (OKLCH `0.44 0.09 56`) on light surfaces; `#E0AB86` (OKLCH `0.78 0.08 56`) on dark. Use it for the logo and a thin identity moment on the board header only. Do not replace ADS brand blue on standard buttons or focus rings (`color.border.focused` stays Atlassian blue).
- Notice chips: `color.background.danger` / `warning` / `success` tints, unique shapes (Due = filled diamond, Upcoming = half-filled square, On track = empty ring), and labels **Due / Upcoming / On track** in `color.text`. Never encode status with colour alone. Never use `color.text.warning` (`#B38600`) as a text label — it fails WCAG AA on white (3.32:1) and on the warning tint (3.09:1). The gold is an icon colour only, and the icon must stay bold.
- Board also groups or filters by 90 / 60 / 30 day windows, on top of the three statuses.
- Show last successful scheduled scan time and how many notices are currently Due.
- Empty, error, and retry states: “no agreements yet — load samples,” missing project, missing Confluence permission, failed scan. All recoverable.
- Accessible labels, keyboard use, visible focus. Contrast as in the theme: body text AAA/AA; status labels use `color.text` on tints.
- English throughout.

## Tests

Add unit tests for notice-by calculation and the Due / Upcoming / On track rules (including “today”, “already past”, the 14/15 and 60/61 boundaries, and leap-year / month-end subtraction). Run them in CI (GitHub Actions on Node 22 or 24). Do not put secrets in CI.

Optional: a small pure function test for the sample-date seeder (one Due, one Upcoming, one On track relative to a frozen “today”).

## Docs and repo files you must write

- `README.md` — what Fides is (and is not); Node 22/24 requirement from live getting-started; `npm install -g @forge/cli@latest`; how a developer with `FORGE_EMAIL` + `FORGE_API_TOKEN` in the environment runs `forge deploy` and `forge install --demo-site`; how to open the notice board, load samples, and invoke the agent in Rovo Chat; warning that the site must come from `forge site provision` because classic `*-dev.atlassian.net` sites often lack Rovo Chat; judge setup that works on a **fresh** site after the Sharing install link (they will not have samples until they click Load samples; they may need to pick a project); architecture; scopes; “not legal advice”; English.
- `LICENSE` — Apache-2.0. Official Codegeist rules do **not** require a public GitHub repo; the install link is the required distribution. Still add this license so the source is clearly licensed if Fluid later makes the repo public.
- `docs/SDK-NOTES.md` — as above.
- `docs/COLOR-THEME.md` — the theme rules (Umber accent, ADS mapping, colourblind chips, contrast notes).
- `docs/HANDOFF.md` — every non-code step, written for Grok Bot and Fluid. Include all of the following, with official URLs, and no token values:
  1. Confirm or complete the Atlassian account on `memequant@mail.grokbot.com` (verification / 2FA as required). **Never** `leviweb3x@gmail.com`.
  2. Create a **Forge-scoped** API token (“Create API token with scopes” → app = Forge) at `https://id.atlassian.com/manage-profile/security/api-tokens`. Store only as a Codespace or GitHub Actions secret named `FORGE_API_TOKEN`, with `FORGE_EMAIL=memequant@mail.grokbot.com`. Never paste the token into chat, a ticket, or the repo.
  3. Open a Codespace or cloud box with Node 22.23.4+ or 24.22.1+ and `@forge/cli@latest`. If credentials are in the environment, do not run `forge login` and do not echo the token.
  4. Run `forge site provision`. Wait for the site URL and expiry. Confirm Jira, Confluence `/wiki`, and **Rovo Chat**. If the pool is full, retry later; do not fall back to a classic `*-dev.atlassian.net` site for the Rovo bonus. If Chat is missing, stop and report — that blocks the bonus. Official: `https://developer.atlassian.com/platform/forge/provision-a-demo-development-site/`.
  5. `forge deploy` and `forge install --demo-site` (or a documented upgrade install after scope changes). Iterate with redeploy or `forge tunnel` if the environment supports it.
  6. In the Forge developer console, set Distribution to **Sharing** (not “Sharing within organization”) and generate the installation link judges will use: `https://developer.atlassian.com/platform/forge/distribute-your-apps/#start-sharing-your-app`. Confirm the app installs on a site that is not only the demo site. Exact console click-paths may change — follow the live UI and that doc.
  7. Pre-flight the acceptance list below on the demo site (samples, board, issue panel, all three Rovo actions, scheduled function wired, no hardcoded IDs, no secrets in git).
  8. Record the public YouTube demo, strictly under 5 minutes, following `DEMO-SCRIPT.md`. Official rules require a **public** YouTube upload and an English soundtrack or captions. **Fluid records and uploads this. Claude Code and Grok Bot do not publish it.**
  9. Submit on Devpost **as Fluid only** by Tue 22 Dec 2026, 9:00 PM WAT: installation link, setup instructions, YouTube URL, text from `SUBMISSION-DRAFT.md`, category Apps for Business Teams, bonus Best Agents. **Do not let an agent submit or post.**
  10. Optional Marketplace paperwork: only if the product is complete. Keep a **separate unlicensed** copy for the judge Sharing link — a licensed or listed app can lose Sharing.
  11. Swap the placeholder icon for the final ChatGPT logo when Fluid provides the SVG.
  12. Optional GitHub Actions deploy workflow that reads `FORGE_EMAIL` and `FORGE_API_TOKEN` from secrets, uses Node 22 or 24, and never prints them. Do not put a live token in the workflow file.
- `DEMO-SCRIPT.md` — public YouTube video strictly under 5 minutes. First 30 seconds, in order: who it is for (legal, procurement, finance, ops); the problem (missed notice periods and auto-renewals — WorldCC names this as a value-leakage bucket; Flexera: only 43% of SAM teams tracked auto-renewal clauses); how Forge plus a Rovo agent **with actions** makes it work inside Jira. Then the live path: install/open, pick a project if needed, Load sample agreements, notice board (Due / Upcoming / On track with labels and shapes), agent lists notices, agent creates a review issue, agent drafts a brief. Mention that judges can repeat this on their own site after install. No secrets, no `leviweb3x@gmail.com`.
- `SUBMISSION-DRAFT.md` — Devpost text ready for Fluid to paste: title Fides; Business Teams category; Best Agents bonus; problem; solution; Forge / Rovo modules used; judge setup; placeholders for the Sharing install link and YouTube URL. Cite only the verified stats, with the Ironclad-co-production caveat. Do not include tokens or `leviweb3x@gmail.com`.
- `.gitignore` — node_modules, env files, credentials, Forge log artefacts, IDE junk.

If this environment cannot run the Forge CLI, still write every source file, test, workflow, and doc, and leave a short “blocked on CLI / demo site” section at the top of `docs/HANDOFF.md`. Do not invent a successful deploy.

## Acceptance (tick these in the README and actually satisfy them)

- [ ] `docs/SDK-NOTES.md` exists, pins Node and CLI/runtime from live docs, and names official board module keys (no invented keys).
- [ ] `forge deploy` succeeds, or HANDOFF clearly states it is blocked on credentials / a provisioned site.
- [ ] `forge install --demo-site` succeeds, or the same honest blockage is documented.
- [ ] Load sample agreements seeds the **current** site (one Due, one Upcoming, one On track) with no hardcoded site, project, or issue IDs.
- [ ] Notice board shows Due / Upcoming / On track with shapes and text labels, plus 90/60/30 grouping, last-scan status, and the legal-advice footer.
- [ ] Issue panel or issue context shows status on a relevant issue.
- [ ] Rovo agent is visible in Rovo Chat (on a `forge site provision` demo site).
- [ ] Action `list-upcoming-notices` returns the samples.
- [ ] Action `create-review-issue` creates a real Jira issue on the current site.
- [ ] Action `draft-brief` is permission-aware and uses the linked page when readable.
- [ ] Daily `scheduledTrigger` is in the manifest (`interval: day`) and the function is wired (last-run visible; errors caught).
- [ ] Unit tests for date and status calculations pass in CI.
- [ ] README, LICENSE (Apache-2.0), DEMO-SCRIPT.md, SUBMISSION-DRAFT.md, docs/HANDOFF.md, docs/COLOR-THEME.md are present and accurate.
- [ ] No API tokens, debug credentials, or `leviweb3x@gmail.com` in git.
- [ ] Repo left private. No Devpost submit. No video upload.

Start now. Verify the docs, write SDK-NOTES, scaffold from the official template, then build the complete product and the handoff docs without waiting for another prompt.

---

## SCOPE ADDENDUM (merge verdict, overrides anything above where they conflict)

Add exactly ONE differentiating feature: **threatened-milestone escalation**. Do not build a full RFI, construction, or contract-lifecycle suite.

- **Blocker model:** a linked child Jira issue represents an outstanding blocker on an agreement (a question, an approval, or an unmet deliverable). Call it a "blocker", never an "RFI". No construction-specific copy anywhere.
- **Escalation rule:** if a blocker is still open AND the linked agreement's notice-by or milestone date is in the RED window (past due, due today, or within 14 days), create exactly ONE escalation issue (idempotent: never duplicate for the same agreement+blocker). It links the agreement, the blocker and the Confluence contract page, and states the date at risk in hedged wording ("may put the notice date of DD MMM at risk"). It is driven by the existing `scheduledTrigger` (`api.asApp()`, caught errors, last-run stamp) AND exposed as a Rovo agent action ("escalate threatened milestones").
- **Phase 1 / seed data:** add a sample RED agreement with one open blocker so the demo shows an escalation being created live. Agreement entry stays manual and structured.
- **Phase 2 / polish:** the Rovo brief adds hedged text on what a miss could mean contractually, plus an optional assistive read of the already-linked Confluence page. Always add "not legal advice".
- **Tests:** unit-test the RED-window boundary (14/15 days, today, past), the open/closed blocker check, and idempotency.
- **Forbidden:** PDF parsers or document upload/extraction (not Phase 1 and not the pitch), invented Forge modules or APIs, a full RFI or CLM suite, construction framing, MCP or Teamwork Graph, and unhedged legal claims.
- **Pitch line:** "Fides connects what an agreement promises to what is actually blocking it, and escalates before the notice window closes."


## WINNING-PATTERN ADDENDUM (approved by Fluid)

Fold in this approved scope addendum for Fides. Don't widen scope beyond it.

1. JUDGE MODE: on install (or first open of the global page), seed demo data idempotently: a few agreements across Due / Upcoming / On track, including one RED agreement (notice-by date within 14 days) with an open linked blocker issue (a question, approval or unmet deliverable; never call it "RFI"). The threatened-milestone escalation must fire for it right away, not only on the scheduled trigger, so a judge lands on the board and sees the escalation issue within 10 seconds with zero manual setup. Seeding must be safe to re-run and must skip when real data exists.
2. SPONSOR DEPTH: Forge + Jira + Confluence + Rovo are the core loop. Put the Rovo agent actions front and centre (list upcoming notices, create review issue, escalate threatened milestones, draft hedged renew/cancel brief) for the Best Agents bonus.
3. README: add a table mapping each of the 5 judging criteria to the Atlassian features used (Forge modules, Jira issues and links, Confluence contract pages, Rovo agent + actions, scheduledTrigger with api.asApp()).
4. ACCEPTANCE TEST: add a check (script, or a documented manual test in docs/HANDOFF.md) that after a fresh install the seeded board plus an escalation issue are visible in under 10 seconds.
5. Log any non-code steps this creates in docs/HANDOFF.md.
