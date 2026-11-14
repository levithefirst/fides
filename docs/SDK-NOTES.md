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
| `function` | 7 handlers | `timeoutSeconds` set on the scheduled scan (300) and install trigger (120); the live scheduled trigger page allows 1 to 900 seconds for scheduled and async functions. |

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

## Demo site in this environment

**Not available.** No `FORGE_EMAIL` / `FORGE_API_TOKEN` were present, and the user asked for no `forge login`, `register`, `deploy` or `install` from this session. Provision, deploy and install are blocked on the human steps in `docs/HANDOFF.md`. No site was faked.

## Differences from the brief, and things to verify on the first deploy

1. **`forge create` was not run.** It needs a logged-in CLI and registers an app, which was out of bounds here. The project follows the official UI Kit template shape by hand (`manifest.yml`, `src/index.js` handlers, `src/frontend/*.jsx` resources, `package.json`). `app.id` is a placeholder; `forge register` fills it.
2. **`forge lint` needs a login**, so it could not run here. `npm run validate:manifest` runs the same `@forge/manifest` schema validation offline and passes. Run `forge lint` on the first logged-in session.
3. **Confluence from a Jira app.** The manifest declares Confluence scopes but no `app.compatibility` block. The live App compatibility page describes multiple-app compatibility (one required app, others optional, paid-only on Marketplace). Verify on the demo site that `requestConfluence` works from the Jira install. If it returns 401/403, add `app.compatibility: { jira: { required: true }, confluence: { required: false } }` and connect Confluence in the admin UI. The app already degrades: agreements and the escalation still seed, and the board shows "Link a page".
4. **Umber accent in UI Kit.** `xcss` typings accept raw colour strings for colour properties, so the header bar uses `#77441A` / `#E0AB86` by `useTheme().colorMode`. If the runtime rejects raw values, swap to `color.border.accent.orange` (see `docs/COLOR-THEME.md`).
5. **Issue link direction** is not relied on. Blockers are linked issues that carry the `fides-blocker` label, found by `issuelinks` then `search/jql`.
6. **`Button` has no `spacing` prop** and **`Label` requires `labelFor`** in UI Kit 12.5; the code follows the typings.
7. **App user permissions for `asApp()`.** The scheduled scan and install seed run as the app. If the app user cannot create issues in the chosen project, the scan stamps the error and the board shows it. Seeding on board open runs as the user and is unaffected.
