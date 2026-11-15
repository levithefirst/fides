# Fides handoff

Everything that cannot be done from a code session, written for Grok Bot and Fluid. No token values appear here or anywhere in the repo.

## Status (read first)

- **Deployed and installed** on the demo site `one-atlas-wptq.atlassian.net` by Fluid. App id `ari:cloud:ecosystem::app/8014edf9-7ace-467e-9b4b-6ae6d9328c9f` is registered in `manifest.yml` (commit fd7cb1c).
- `forge lint` rejected `timeoutSeconds` on the `on-install` function; it was removed (commit cf6fa02).
- First live run: board rendered in 8.8 s with all four agreements and correct chips; the Helios escalation was created (CLSD-12); Rovo "List upcoming notices" worked; logs clean.
- Fixed after that run (redeploy needed, no scope change, so `forge deploy` is enough; no `--upgrade`):
  1. Sample agreements seeded before Confluence was connected are now linked to their pages (install event, board open, daily scan). See step 8C.
  2. Install-time seeding is best effort with retry and back-off; the official 10 s check is now "open the board after install". See step 8.
  3. The umber accent bar above the board heading now renders (see `docs/COLOR-THEME.md`).
- Code sessions do not run `forge login`, `register`, `deploy` or `install`; Fluid deploys.

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

### 8. Judge-mode acceptance test (scope addendum item 4)

**The official 10 s check is "open the board after install".** Pass condition: on a fresh install, within 10 seconds of opening **Apps > Fides**, the board shows the seeded agreements and the escalation issue exists, with zero manual setup.

Why board open and not install time: on a new install Atlassian grants the app user its permissions with a delay (live run on one-atlas-wptq: issues appeared 47 s after install). Board-open seeding runs as the person opening the board, so it does not wait for that. Install-time seeding is **best effort**: the `on-install` trigger first probes whether the app can see any project; if not, it returns a retry (10 s, 30 s, 90 s, 270 s back-off, Forge's four retries) without taking the seed lock, so it never blocks the board. If it is still not ready after the last retry, it gives up quietly and board open seeds.

**A. Board-open check (official).** On a site where Fides has never been installed, or after `forge uninstall` (KVS is cleared on uninstall). Open the board **soon after install** (within about 10 s, before the install trigger's first retry can seed), so the check measures the guaranteed path.

1. `forge install --demo-site` (or install from the Sharing link on a second site).
2. In a terminal, start the timer script:

   ```bash
   JIRA_BASE_URL=https://<site>.atlassian.net \
   ATLASSIAN_EMAIL=memequant@mail.grokbot.com \
   ATLASSIAN_API_TOKEN=<classic API token from the environment, not FORGE_API_TOKEN> \
   node scripts/acceptance-live.mjs
   ```

3. When it prompts, open **Apps > Fides** and press Enter at the same moment. It polls Jira and prints PASS if four sample agreements and exactly one escalation exist within 10 s, and reports how many agreements carry a Confluence page link.
4. Also confirm visually, with a stopwatch from the same moment, that the board shows:
   - four agreements: Helios Payroll (**Due**, diamond), Larkspur Facilities and Northwind Analytics (**Upcoming**, half square), Quay Support (**On track**, ring);
   - the amber **Threatened milestones escalated** message naming the Helios escalation issue;
   - a last-scan line with source `judge-mode (board-open)` (or `judge-mode (install)` if install seeding got there first);
   - the thin umber bar above the "Notice board" heading.
5. Open the escalation issue and check it:
   - summary like `Escalation: Helios Payroll notice date DD MMM may be at risk (KEY-n)`;
   - description says the blocker "may put the notice date of DD MMM at risk";
   - linked to the agreement and to the blocker ("Approval pending: finance sign-off ..."), with a remote link to the Confluence contract page once Confluence is connected (see C);
   - footer "Fides tracks dates and obligations; it is not legal advice."
6. Re-run safety: reload the board three times and click **Run scan now**. Still exactly **one** escalation (JQL `labels = fides-escalation`), four sample agreements (`labels = fides-sample AND labels = fides-agreement`), and four sample pages in Confluence (search the title prefix "Fides sample contract:").
7. Real-data skip: on a second fresh site, create any Jira issue labelled `fides-agreement` (without `fides-sample`) **before** installing Fides. Install and open the board. No samples may appear and the seed state is `skipped`. Clicking **Load samples** afterwards is an explicit request and does seed them.

**B. Install-time timing (informational, never a pass/fail gate).** `node scripts/acceptance-live.mjs --install` right after `forge install` returns, without opening the board. It reports how long install-time seeding took (expect tens of seconds on a brand-new install) and always exits 0.

**C. Confluence link backfill (gap fixed after the first live run).** If Jira was installed before Fides was connected to Confluence, the sample agreements were seeded without pages. Now, when Fides is connected to Confluence (the install event fires again), on every board open, and in the daily scan, Fides finds each sample page by its stored page record or by exact title in any space ("Fides sample contract: <vendor>"), creates it only if Confluence confirms none exists, adds the remote link to the agreement plus its review and escalation issues (stable `globalId`, so no duplicates), and stores the page id. To verify on one-atlas-wptq after redeploy: open the board once; every card should show **Open page** instead of **Link a page**, and the agreement issues should each have exactly one "Contract page" link. Reloading changes nothing (it makes no API calls once everything is linked).

**D. Offline simulation (CI).** `npm test` runs `test/judge-mode.test.mjs` and `test/install.test.mjs`: a fresh simulated site at 400 ms per REST call seeds the board and the escalation in about 4.4 s (37 calls; about 8.8 s at 800 ms). Also covered: backfill linking, rerun with no changes, no duplicate pages under concurrency, and install retry with back-off. Override latency with `FIDES_SIM_LATENCY_MS`.

Record the result of A (script output and stopwatch time) in the README acceptance list. First live run, before these fixes: board rendered in 8.8 s with all four agreements; the install-time poll failed its 10 s budget (47 s), which is now informational.

### 8E. First-screen and clean-site checks (after the brutal-judge fixes)

1. Cold board: on a fresh install, open the board. Within a second you see the labelled **"Seeding sample agreements..."** banner (never a bare spinner), the Helios row and escalation appear while the banner still shows progress, and everything is in place within 10 s.
2. First viewport, without scrolling: the umber bar, the Due spotlight (Helios Payroll; "Notice by ... = end date ... minus 30 days notice"; open blocker; escalation key; "A date reminder can't see that this blocker is still open."), and the Ask Fides panel with the chained ask as the first button.
3. No Rovo: on a site without Rovo Chat, the board and escalation still render and the Ask panel says "Rovo Chat is needed for the Fides agent."
4. No Confluence: before connecting Confluence, cards show **Link a page** and a note under the table explains it.
5. Cannot create issues: sign in as a user without Create issues permission on a fresh install. The board shows "Fides cannot create issues for you" with the permission to request, not a blank page and not a project picker.
6. Project picker appears only when projects exist but none could be picked automatically.

### 9. Pre-flight the full acceptance list on the demo site

From the README: samples on the current site with no hardcoded IDs, board with three labelled statuses and shapes plus 30/60/90 grouping, last-scan status and footer, issue panel on agreement and escalation issues, all **four** Rovo actions (list, create review, escalate, draft brief), daily scan wired (wait for the first scheduled run about five minutes after deploy and check the last-scan source reads `scheduledTrigger`), no secrets in git (`git grep -nI -e token -e password`).

Rovo checks (new, sponsor depth):

1. On the board, click each **Ask Fides in Rovo** button; Rovo Chat opens with the Fides agent and the prompt filled.
1a. Chained ask (primary demo): "Is Helios at risk, and what should I do?". In Rovo Chat the agent should call, in order, List upcoming notices, Escalate threatened milestones, Draft renew or cancel brief (action cards appear in the chat). The answer must name the open blocker, the **existing** escalation key (CLSD-12 on one-atlas-wptq; no new escalation issue may appear in Jira), hedged renew / cancel / renegotiate options, and end with "Fides tracks dates and obligations; it is not legal advice." If the agent stops after the first action, note it: the prompt says not to stop between steps.
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
| 4. Acceptance test | Run the board-open check 8A on a fresh install and record the time; 8B is informational | Step 8 |
| 5. This log | Keep this table current | |
