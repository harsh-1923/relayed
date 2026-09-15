# Composio discovery spike

Evidence for agents finding their own tools at run time instead of a creator
picking them — the plan's step 7
([`docs/WORKSPACE-AGENTS-IMPL.md`](../../docs/WORKSPACE-AGENTS-IMPL.md), agents
find their own tools). Plain `fetch` against Composio's REST API v3.1, the same
way `apps/server/src/agents/composio.ts` calls it: no SDK, no dependencies, not
a workspace member.

## Run

From this directory, against the development Composio project in the root
`.env`:

```bash
node --env-file=../../.env 0-accounts.mjs   # who is connected at Composio right now
node --env-file=../../.env 1-sessions.mjs   # one session per person, switches off
node --env-file=../../.env 2-search.mjs     # search: tools, connection status, latency
node --env-file=../../.env 3-execute.mjs    # executing by name: pinning, every error shape
node --env-file=../../.env 4-size.mjs       # what the model would be handed, in tokens
```

Each writes `results/<script>.json`. `2-search.mjs` and `3-execute.mjs` depend on
the sessions `1-sessions.mjs` saved. **Read-only against GitHub**: every tool
executed is a `readOnlyHint` tool.

**Personal data is kept out of `results/`.** A connected search returns the
person's whole GitHub profile (`current_user_info`); the script redacts it before
saving, and executions keep only the *keys* of what came back, never the values.

Two people were used: the development project's one account with an `ACTIVE`
GitHub connection (`user_id` `pg-test-…`, from an earlier test), and a real actor
id with no connection at all.

## Result — 2026-09-15

### Sessions (`1-sessions.mjs`)

| Question | Answer | Consequence |
|---|---|---|
| Can a session be created per person with no tool list, limited to the enabled toolkits? | Yes: `toolkits: { enable: ['github', 'notion'] }`, 201 in 730–880ms | One session per person, not per (agent, person, agent version) |
| Do the off switches take? | Yes. With `manage_connections`, `workbench` and `execute.enable_multi_execute` all off, the session's meta tools shrink from five to `COMPOSIO_SEARCH_TOOLS` and `COMPOSIO_GET_TOOL_SCHEMAS` | Nothing on the session can connect an account or run a tool on Composio's side. We never hand either meta tool to the model anyway |

### Search (`2-search.mjs`)

`POST /tool_router/session/:id/search` with `{ "queries": [{ "use_case": "…" }] }`.

| Query | Top tools returned | GitHub connected? |
|---|---|---|
| look at github issue #445 and tell me about it | `GITHUB_GET_AN_ISSUE` (or `GITHUB_LIST_REPOSITORY_ISSUES`) | reported correctly both ways |
| what was my latest commit | `GITHUB_GET_A_REPOSITORY`, `GITHUB_LIST_COMMITS` | yes |
| review pull request #4561 and leave comments | `GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST` — a **write** tool | yes |
| find the onboarding page in notion and summarise it | `NOTION_SEARCH_NOTION_PAGE`, `NOTION_GET_PAGE_MARKDOWN` | Notion: no, correctly |
| send a message to the #eng slack channel — **Slack is not enabled** | `GITHUB_CREATE_A_DISCUSSION_COMMENT`, or `GITHUB_GET_THE_ZEN_OF_GITHUB` | — |
| help me with my work | `GITHUB_WHO_AM_I`, `NOTION_WHO_AM_I` — two toolkits | both reported |

| Question | Answer | Consequence |
|---|---|---|
| Does search work for a person with no connection? | Yes, with `has_active_connection: false` for each toolkit it returns | The not-connected signal we raise the card on |
| Does it stay inside the session's toolkits? | Yes — never a Slack tool | — |
| **Does it say "nothing fits"?** | **No.** A Slack request returned GitHub tools. It always returns *something* from what is enabled | The model must be told which toolkits exist, and told that a result from the wrong service is not a match. Otherwise "post in Slack" becomes a GitHub discussion comment |
| Is it deterministic? | **No.** The same query ten times gave four different top sets, all reasonable | Nothing may depend on the exact tools returned; tests must not snapshot them |
| Latency | **p50 2.1s, max 3.1s** (10 runs); 1.5–2.7s across all queries | A second or two before the first tool call of a run. Acceptable for a chat reply, too slow to do on every model turn — search once per need, not per call |
| How many schemas come back? | Six tools; the top **three** with full schemas, three as a `schemaRef` to `COMPOSIO_GET_TOOL_SCHEMAS` | We fill the rest from `toolkit_tools.input_schema`, which holds every schema — no second call |
| What must not reach the model? | `status_message` and `next_steps_guidance` say "You MUST call COMPOSIO_MANAGE_CONNECTIONS" even with it off; `recommended_plan_steps` names `COMPOSIO_REMOTE_WORKBENCH`, which is off; `session.instructions` asks for a Composio session id on later calls; **`current_user_info` is the person's whole provider profile**; `connection_details` holds the Composio account id | The server returns its own shape — names, descriptions, schemas — built from the response, never the response passed through |

### Executing by name (`3-execute.mjs`)

`POST /tool_router/session/:id/execute` with `{ "tool_slug", "arguments" }`.

| Case | HTTP | What comes back | Maps to |
|---|---|---|---|
| Connected, session **not pinned** to an account | 200 | the data | ok |
| Connected, pinned, tool **never searched for** | 200 | the data | ok — search is not a gate |
| Not connected | **400** | `ToolRouterV2_NoActiveConnection` (code 4302) | `connection_required` |
| Toolkit not in the session (Hacker News) | **400** | `ToolRouterV2_ToolkitNotAllowed` (code 4324): `[Session Restriction] Toolkit 'hackernews' is not allowed for this session` | `tool_not_allowed` |
| Tool name that does not exist | **400** | `ToolRouterV2_ToolNotFound` (code 4301) | `tool_not_allowed` |
| A required argument missing | **200** | `error: "Invalid request data provided - Following fields are missing: {'repo'}"` | `failed`, with the message — the model can correct itself |
| The provider refuses (a repository that does not exist) | **200** | `error` holds GitHub's own `{"message":"Not Found", … "status":"404"}` | `failed`, with the message |
| Add an account to an existing session later (`PATCH /tool_router/session/:id` with `connected_accounts`) | 200 | the session's config now pins it; execute works | A session can follow a reconnect without being recreated |
| Pin **someone else's** account onto a session | **400** | "Could not find connected account(s) … belonging to user …" | Composio itself refuses a session reaching another person's account — defence in depth under our own check |

Executions took **750–950ms** (2s for the invalid-arguments case).

**This contradicts `apps/server/src/agents/composio.ts`.** Its comment records a
live check on 2026-09-14 that a session created without `connected_accounts`
fails `ToolRouterV2_NoActiveConnection` even for an `ACTIVE` account. Here an
unpinned session executed normally. That session was created with a `tools` list
and `preload: { tools: 'all' }`, and this one without either; which of those — or
a change at Composio — explains the difference was not isolated. Not tested
either: a person with an `EXPIRED` and an `ACTIVE` account for the same toolkit,
where an unpinned session would have to choose.

### Size (`4-size.mjs`)

| What the model would be sent | Tokens (bytes ÷ 4) |
|---|---|
| The raw search response | ~2,600 |
| **The cleaned `find_tools` result** — six names, descriptions, three full schemas | **~1,400** |
| Every GitHub tool's schema (894 tools) | ~459,000 |
| Every Notion tool's schema (57 tools) | ~92,000 |

Even the smallest enabled toolkit cannot be sent whole. Search is required for
every toolkit, not only the large ones.

### Not answered here

- **Whether a search is billed** as a tool call. Nothing in the API says; check
  the development project's usage page in the Composio dashboard after this run
  (about 30 searches and 12 executions).
- **Search quality at scale** — six queries against two toolkits is not a
  benchmark. Worth re-running when a third toolkit is enabled.
