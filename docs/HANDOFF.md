# Fides handoff

Everything that cannot be done from a code session, written for Grok Bot and Fluid. No token values appear here or anywhere in the repo.

## Blocked on CLI / demo site (read first)

This build session did **not** run `forge login`, `forge register`, `forge deploy`, `forge install` or `forge site provision`, by instruction. So:

- `app.id` in `manifest.yml` is a placeholder (`ari:cloud:ecosystem::app/00000000-...`). `forge register` replaces it.
- `forge lint` was not run (it needs a login). The offline schema check `npm run validate:manifest` passes.
- Nothing has been deployed or installed. No site was faked. The acceptance items that need a live site are marked as pending in the README.
- What was verified here: 27 unit and integration tests (`npm test`), manifest schema validation, and a full bundle of the backend and both UI Kit resources.

## Steps

### 1. Atlassian account

Confirm or complete the Atlassian account on `memequant@mail.grokbot.com` (email verification and 2FA as prompted). Use only this account for the project. **Never** use Fluid's personal address.

### 2. Forge-scoped API token

1. Go to `https://id.atlassian.com/manage-profile/security/api-tokens`.
2. Click **Create API token with scopes**, name it (for example `fides-forge`), pick an expiry, select **Forge** as the app, keep the recommended scopes, create, copy.
3. Store it only as a Codespace or GitHub Actions secret named `FORGE_API_TOKEN`, with `FORGE_EMAIL=memequant@mail.grokbot.com`.
4. Never paste the token into chat, a ticket, a commit or a file.

Official: `https://developer.atlassian.com/platform/forge/getting-started/#log-in-with-an-atlassian-api-scoped-token`

### 3. Build box

Open a Codespace or cloud box with Node 22.23.4+ or 24.22.1+ (`nvm use` reads `.nvmrc`), then:

```bash
npm install -g @forge/cli@latest
npm ci
npm test
npm run validate:manifest
```

If `FORGE_EMAIL` and `FORGE_API_TOKEN` are in the environment, do **not** run `forge login` and do not echo the token. The CLI reads them directly.

### 4. Register the app (new, from this build)

```bash
forge register        # name: Fides. Replaces the placeholder app.id in manifest.yml
forge lint            # first logged-in lint; fix anything it reports
git commit -am "Register Fides app id"
```

### 5. Provision a demo site

```bash
forge site provision
```

Wait for the site URL and expiry. Confirm Jira, Confluence at `/wiki`, and **Rovo Chat** in the top bar. If the pool is full, retry later. Do **not** fall back to a classic `*-dev.atlassian.net` site for the Rovo bonus. If Chat is missing, stop and report: that blocks the Best Agents bonus.

Official: `https://developer.atlassian.com/platform/forge/provision-a-demo-development-site/`

New for judge mode: the site needs **at least one Jira project** where issues can be created and ideally **one non-personal Confluence space**. Demo sites ship with seeded data, so this is normally already true. If not, create a project (any template) and a space before step 6.

### 6. Deploy and install

```bash
forge deploy
forge install --demo-site
```

After any scope change in `manifest.yml`: `forge deploy` then `forge install --upgrade`. Use `forge tunnel` for hot reload while iterating.

### 7. Verify Confluence access from the Jira install (new)

Open the Fides board. If the sample agreements show **Open page** links, Confluence works. If every agreement shows **Link a page** and the board otherwise works, the Jira install cannot call Confluence: add to `manifest.yml`

```yaml
app:
  compatibility:
    jira:
      required: true
    confluence:
      required: false
```

then `forge deploy`, `forge install --upgrade`, and connect the app to Confluence in the site admin's connected apps page. Record the outcome in `docs/SDK-NOTES.md`, item 3. Official: `https://developer.atlassian.com/platform/forge/app-compatibility/`

### 8. Judge-mode acceptance test (new, scope addendum item 4)

The pass condition: **after a fresh install, the seeded board and the escalation issue are visible in under 10 seconds, with zero manual setup.**

**A. Manual board-open test (primary).** Do this on a site where Fides has never been installed, or after `forge uninstall` (KVS is cleared on uninstall).

1. `forge install --demo-site` (or install from the Sharing link on a second site).
2. Start a stopwatch and open **Apps > Fides** in Jira.
3. Stop the stopwatch when all of these are visible:
   - four agreements: Helios Payroll (**Due**, diamond), Larkspur Facilities and Northwind Analytics (**Upcoming**, half square), Quay Support (**On track**, ring);
   - the amber **Threatened milestones escalated** message naming an escalation issue for Helios Payroll;
   - a last-scan line with source `judge-mode (install)` or `judge-mode (board-open)`.
4. Pass if under 10 seconds. Open the escalation issue and check it:
   - summary like `Escalation: Helios Payroll notice date DD MMM may be at risk (KEY-n)`;
   - description says the blocker "may put the notice date of DD MMM at risk";
   - linked to the agreement issue and to the blocker issue ("Approval pending: finance sign-off ..."), with a remote link to the Confluence contract page (unless step 7 found Confluence blocked);
   - footer "Fides tracks dates and obligations; it is not legal advice."
5. Re-run safety: reload the board three times and click **Run scan now**. There must still be exactly **one** escalation issue (JQL `labels = fides-escalation`) and four sample agreements (`labels = fides-sample AND labels = fides-agreement`).
6. Real-data skip: on a second fresh site, create any Jira issue labelled `fides-agreement` (without `fides-sample`) **before** installing Fides. Then install and open the board. No samples may appear and the seed state is `skipped` (Fides counts a `fides-agreement` issue without the sample label as real data). Clicking **Load samples** afterwards is an explicit request and does seed them.

**B. Install-path poll (secondary).** Right after `forge install` completes on a fresh site:

```bash
JIRA_BASE_URL=https://<site>.atlassian.net \
ATLASSIAN_EMAIL=memequant@mail.grokbot.com \
ATLASSIAN_API_TOKEN=<classic API token from the environment, not FORGE_API_TOKEN> \
node scripts/acceptance-live.mjs
```

It prints PASS when four sample agreements and exactly one escalation exist within 10 seconds of the script starting. A FAIL here with a PASS in test A means the install trigger was waiting on app permissions (documented Forge behaviour). Judges still see the board seeded on first open.

**C. Offline simulation (already passing in CI).** `npm test` runs `test/judge-mode.test.mjs`: a fresh simulated site at 400 ms per REST call seeds the board and the escalation in about 4.4 s (37 calls); at 800 ms per call, about 8.8 s. Override with `FIDES_SIM_LATENCY_MS`.

Record the stopwatch time from test A in the README acceptance list.

### 9. Pre-flight the full acceptance list on the demo site

From the README: samples on the current site with no hardcoded IDs, board with three labelled statuses and shapes plus 30/60/90 grouping, last-scan status and footer, issue panel on agreement and escalation issues, all **four** Rovo actions (list, create review, escalate, draft brief), daily scan wired (wait for the first scheduled run about five minutes after deploy and check the last-scan source reads `scheduledTrigger`), no secrets in git (`git grep -nI -e token -e password`).

Rovo checks (new, sponsor depth):

1. On the board, click each **Ask Fides in Rovo** button; Rovo Chat opens with the Fides agent and the prompt filled.
2. "What notices are due in the next 60 days?" lists Helios first as Due.
3. "Escalate threatened milestones" reports the existing escalation and creates no duplicate.
4. "Create a review issue for Helios Payroll" returns the existing open review issue (judge mode opened one) or creates one.
5. "Draft a renew or cancel brief for Helios Payroll" quotes the contract page and ends with the not-legal-advice line.
6. Permission check: as a user without access to the Confluence space, the brief says it could not read the page and continues from stored obligations.

### 10. Sharing link for judges

In the Forge developer console, set Distribution to **Sharing** (not "Sharing within organization") and generate the installation link. Confirm the app installs on a site that is not the demo site, and run test 8A there. Console click paths change; follow the live UI and `https://developer.atlassian.com/platform/forge/distribute-your-apps/#start-sharing-your-app`.

### 11. Demo video (Fluid only)

Record the public YouTube demo, strictly under 5 minutes, following `DEMO-SCRIPT.md`. English soundtrack or captions. Show judge mode live: fresh install, open the board, the escalation appears without any clicks. **Fluid records and uploads. Claude Code and Grok Bot do not publish it.**

### 12. Devpost submission (Fluid only)

Submit **as Fluid only** by **Tue 22 Dec 2026, 9:00 PM WAT** (3:00 PM EST): installation link, setup instructions (README "Judge setup"), YouTube URL, text from `SUBMISSION-DRAFT.md`. Category: Apps for Business Teams. Bonus: Best Agents. **Do not let an agent submit or post.**

### 13. Optional Marketplace paperwork

Only if the product is complete. Keep a **separate unlicensed** copy of the app for the judge Sharing link: a licensed or listed app can lose Sharing. Note that adding `app.compatibility` (step 7) restricts Marketplace listings to paid apps.

### 14. Logo

The final logo is already in `assets/brand/` and wired in (`static/icons/fides.svg` for the issue panel and agent avatar). No placeholder swap is needed. If Fluid delivers a revised SVG, replace both `assets/brand/fides-logo.svg` and `static/icons/fides.svg`.

### 15. Optional deploy workflow

A GitHub Actions deploy job can read `FORGE_EMAIL` and `FORGE_API_TOKEN` from repository secrets, use Node 22 or 24, run `npm ci && forge deploy --non-interactive -e development`, and never print the secrets. Not added yet, so no workflow can deploy by accident. Do not put a live token in any workflow file.

## Non-code steps created by the scope addendum (summary)

| Addendum item | Non-code step | Where |
| --- | --- | --- |
| 1. Judge mode | Demo site needs one Jira project and one Confluence space; verify Confluence from the Jira install | Steps 5 and 7 |
| 2. Sponsor depth | Check all four Rovo actions in Rovo Chat, including the permission case | Step 9 |
| 3. README criteria table | None (done in README) | |
| 4. Acceptance test | Run tests 8A and 8B on a fresh install and record the time | Step 8 |
| 5. This log | Keep this table current | |
