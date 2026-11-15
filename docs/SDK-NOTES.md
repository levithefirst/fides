# SDK notes

Verified against live Atlassian developer docs on **14 Nov 2026**. Where the build brief and the live docs differ, the live docs win and the difference is listed at the bottom.

## Toolchain

| Item | Value | Source |
| --- | --- | --- |
| Node.js | 22.x (22.23.4 or later) or 24.x (24.22.1 or later). `.nvmrc` pins 24; `engines` allows both. Built and tested here on 22.23.4. | Forge getting started, last updated 26 Aug 2026 |
| `@forge/cli` | 15.1.0 (npm `latest` at build time). `forge --version` printed `15.1.0`. Install with `npm install -g @forge/cli@latest`. | npm registry |
| Runtime | `app.runtime.name: nodejs24.x` | brief + getting started Node range |
| `@forge/api` | 8.5.0 | npm |
| `@forge/kvs` | 2.1.2 | npm |
| `@forge/react` (UI Kit) | 12.5.0 | npm |
| `@forge/bridge` | 7.3.0 | npm |
| `@forge/resolver` | 2.0.2 | npm |
| `@forge/events` | 3.0.10 | npm |
| `@forge/manifest` (dev, offline schema check) | 13.9.0 | npm |

## Modules used (all from live module index pages)

| Module | Key in manifest | Notes |
| --- | --- | --- |
| `jira:globalPage` | `fides-board` | Primary, site-level notice board in the Apps section, so agreements are not trapped in one project. Properties used: `resource`, `render: native`, `resolver.function`, `title`, `layout: native`. |
| `jira:issuePanel` | `fides-issue-panel` | Shows notice status on agreement, review, blocker and escalation issues. `icon` is required on this module and points at `resource:static;icons/fides.svg`. |
| `scheduledTrigger` | `fides-daily-scan` | `interval: day`. |
| `trigger` | `fides-on-install` | Event `avi:forge:installed:app` (live life cycle events page). Runs judge-mode seeding with `api.asApp()`. |
| `rovo:agent` | `fides-agent` | Name `Fides` (limit 30 characters). Prompt is a resource file (`resource:static;agent/prompt.txt`, needs CLI 10.6.0+). Icon, description, four conversation starters, four actions. |
| `action` | `list-upcoming-notices`, `create-review-issue`, `escalate-threatened-milestones`, `draft-brief` | `actionVerb` values from the live action page: `GET`, `CREATE`, `UPDATE`, `DELETE`, `TRIGGER`. Fides uses `GET` (list, brief) and `CREATE` (review, escalate). Every action declares `inputs` (mandatory) with `title`, `type`, `required`, `description`. |
| `function` | 7 handlers | `timeoutSeconds` is set only on the scheduled scan (300); the live scheduled trigger page allows 1 to 900 seconds for scheduled and async functions. `forge lint` rejected it on the `on-install` (product trigger) function, so it was removed there (live finding, commit cf6fa02). |

Not used: `jira:projectPage` (optional in the brief; the global page already filters to agreements you can see), `jira:issueContext`, `rovo:mcp`, `rovo:agentConnector`, `graph:connector`, Teamwork Graph. Not invented: `jira:globalSidebar` (the offline validator rejects it, which is a good test that validation is real).

## Scheduled trigger facts (live page, updated 17 Jun 2026)

- Intervals: `fiveMinute`, `hour`, `day`, `week`.
- Up to five scheduled triggers per app.
- First run about five minutes after deploy. Changing any scheduled trigger module recreates all of them and resets start times.
- Runs **without a user context**: `principal` is not a user. Fides uses `api.asApp()` there.
- A thrown error is not retried; the next run happens on schedule. Fides catches every error and writes a `lastRun` stamp to KVS (`ok`, `errors`, `lastSuccessAt`), shown on the board.
- Small chance of duplicate invocations: Fides makes escalation and review creation idempotent (KVS `FAIL_IF_EXISTS` claims plus Jira label guards).
- Manual proof without waiting 24 hours: the board's **Run scan now** button calls the same `runScan` function (as the user) and stamps `lastRun` with source `manual (board)`. No dev-only web trigger is shipped.

## Life cycle trigger facts (live page, updated 7 Apr 2026)

- `avi:forge:installed:app` payload: `id`, `installerAccountId?`, `app`, `environment?`.
- The installed event can arrive before the app user has its permissions. Fides returns `InvocationError` with `FUNCTION_RETRY_REQUEST` and exponential back-off on 401/403, as the live example shows (Forge retries up to 4 times).
- Because of that delay, judge mode **also** seeds on first open of the global page (as the user). A KVS lock (`lock:seed`, `FAIL_IF_EXISTS`, 90 s TTL) makes the two paths seed exactly once.
- Live finding (one-atlas-wptq): sample issues appeared 47 s after install. The install handler now probes readiness (can the app see any project?) before taking the lock, and returns retries at 10 / 30 / 90 / 270 s. Board open is the guaranteed path; install seeding is best effort.
- The same installed event fires when the app is connected to Confluence. The handler then runs the Confluence page backfill (see below).

## Storage

- Package `@forge/kvs`, scope `storage:app` (live KVS page).
- `kvs.get`, `kvs.set`, `kvs.delete`, `kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(n).cursor(c).getMany()`.
- `kvs.set(key, value, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { value, unit: 'SECONDS' } })` from the 2.1.2 typings (`PolicySetOptions`). Used for the seed lock and escalation claims.
- `kvs.query` is eventually consistent (live docs), so claims use direct `set`/`get`, never a query, to decide idempotency.

## Product REST endpoints (live REST docs)

Jira Cloud REST v3 (`api.asUser().requestJira` / `api.asApp().requestJira`):

| Purpose | Endpoint |
| --- | --- |
| Site base URL for links | `GET /rest/api/3/serverInfo` |
| Discover projects | `GET /rest/api/3/project/search` |
| Standard issue type for a project | `GET /rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes` (reads `issueTypes`, falls back to `values`) |
| Create agreement, blocker, review, escalation issues | `POST /rest/api/3/issue` |
| Read issue with links | `GET /rest/api/3/issue/{idOrKey}?fields=summary,status,labels,issuelinks,project,issuetype` |
| Search | `POST /rest/api/3/search/jql` (`/rest/api/3/search` is deprecated and being removed) |
| Permission-aware visibility filter | `POST /rest/api/3/issue/bulkfetch` (`issueIdsOrKeys`, returns `issues` and `issueErrors`) |
| Link types | `GET /rest/api/3/issueLinkType` |
| Link issues | `POST /rest/api/3/issueLink` |
| Link the Confluence page | `POST /rest/api/3/issue/{key}/remotelink` |
| Ping a review issue | `POST /rest/api/3/issue/{key}/comment` |

Confluence Cloud REST v2 (`requestConfluence`):

| Purpose | Endpoint | Scope |
| --- | --- | --- |
| Pick a space for sample pages | `GET /wiki/api/v2/spaces` | `read:space:confluence` |
| Find a sample page by title (idempotency) | `GET /wiki/api/v2/pages?space-id=&title=` | `read:page:confluence` |
| Create a sample page | `POST /wiki/api/v2/pages` (`spaceId`, `status`, `title`, `body.representation`, `body.value`) | `write:page:confluence` |
| Read the contract page for the brief | `GET /wiki/api/v2/pages/{id}?body-format=storage` | `read:page:confluence` |

## Scopes

`read:jira-work`, `write:jira-work`, `storage:app`, `read:page:confluence`, `write:page:confluence`, `read:space:confluence`. After any scope change, run `forge deploy` then `forge install --upgrade` (see README).

## UI Kit and bridge (from installed typings)

- `@forge/react` 12.5.0 components used: `Box`, `Stack`, `Inline`, `Heading`, `Text`, `Button`, `ButtonGroup`, `Link`, `Select`, `DynamicTable`, `SectionMessage`, `EmptyState`, `Spinner`, `Modal*`, `Textfield`, `TextArea`, `DatePicker`, `Label`, `xcss`, `useTheme`.
- `@forge/bridge` `rovo.open({ type: 'forge', agentKey, agentName, prompt })` and `rovo.isEnabled()` power the "Ask Fides in Rovo" buttons.
- `Text` `color` accepts `color.text*` tokens only; status labels use `color.text`.

## Demo site

Fluid deployed and installed Fides on `one-atlas-wptq.atlassian.net`. Code sessions do not run `forge login`, `register`, `deploy` or `install`.

## Differences from the brief, and things to verify on the first deploy

1. **`forge create` was not run.** It needs a logged-in CLI and registers an app, which was out of bounds here. The project follows the official UI Kit template shape by hand (`manifest.yml`, `src/index.js` handlers, `src/frontend/*.jsx` resources, `package.json`). `app.id` is a placeholder; `forge register` fills it.
2. **`forge lint` needs a login**, so it could not run here. `npm run validate:manifest` runs the same `@forge/manifest` schema validation offline and passes. Run `forge lint` on the first logged-in session.
3. **Confluence from a Jira app.** Live: Confluence became reachable only after the separate Confluence install, after Jira seeding had already run; the backfill in item 5 now links the pages. Original note: The manifest declares Confluence scopes but no `app.compatibility` block. The live App compatibility page describes multiple-app compatibility (one required app, others optional, paid-only on Marketplace). Verify on the demo site that `requestConfluence` works from the Jira install. If it returns 401/403, add `app.compatibility: { jira: { required: true }, confluence: { required: false } }` and connect Confluence in the admin UI. The app already degrades: agreements and the escalation still seed, and the board shows "Link a page".
4. **Umber accent in UI Kit (live finding).** A raw hex string in `xcss` `backgroundColor` rendered nothing. In UI Kit 12.5 `Box` colour values are `ColorToken | ThemeHexColor`, where `ThemeHexColor` is `{ light, dark }`. The bar now uses `{ light: '#77441A', dark: '#E0AB86' }` over a `color.background.accent.yellow.bolder` token layer, and gets its 4 px thickness from `paddingBlock: 'space.025'` rather than a raw height. See `docs/COLOR-THEME.md`.
5. **Confluence page backfill.** Page lookup uses `GET /wiki/api/v2/pages?title=&status=current` without `space-id`, so pages created in any space (on the demo site: space EO, created by the Confluence install) are found. Remote links are posted with a stable `globalId` (`fides-confluence-page-<id>`); the live Jira docs say an existing link with the same `globalId` is updated, which makes reruns idempotent. Pages are created only when Confluence answered the title lookup with no match, under a per-sample KVS lock.
6. **Issue link direction** is not relied on. Blockers are linked issues that carry the `fides-blocker` label, found by `issuelinks` then `search/jql`.
7. **`Button` has no `spacing` prop** and **`Label` requires `labelFor`** in UI Kit 12.5; the code follows the typings.
8. **App user permissions for `asApp()`.** The scheduled scan and install seed run as the app. If the app user cannot create issues in the chosen project, the scan stamps the error and the board shows it. Seeding on board open runs as the user and is unaffected.
