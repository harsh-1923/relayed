# Local rooms

> **Status: a proposal, not yet the design of record.** Nothing in this document
> is built. Where it disagrees with [`DESIGN.md`](DESIGN.md) — and it does, in
> the sections on agents at the transport layer (§6.5) and agents (§13.8), which
> say an agent never runs on a laptop — the disagreement is deliberate and §16
> lists the edits that would make the design of record agree. Until those land,
> `DESIGN.md` wins.
>
> Companion to [`AGENT-RUNTIME.md`](AGENT-RUNTIME.md), which is the *service*
> side of the same story: what runs an agent once a room has been published.
> This document is the *laptop* side: what runs before.

**Last updated:** 2026-09-13

---

## 0. Words used here

Plain meanings for the terms this document leans on. Most already have a precise
definition elsewhere; this is the short version.

| Word | Meaning here |
|---|---|
| **Room** | A shared space that holds several conversations at once — a main one plus any number of side ones — instead of just one (`DESIGN.md`, the containment model in §7.1). |
| **Chat** | One conversation, one list of messages. A room has one *default* chat and any number of named ones. |
| **Panel** | A second thing open beside the main conversation — today another chat, and from this document a web page too. |
| **Thread** | Replies hanging off one message, shown in their own pane. |
| **Replica** | The local copy of a workspace that the server can rebuild at any time. Lives in `relayed.db`. |
| **Sync engine** | The background process that owns every database and the socket to the server. The screen never touches a database directly; it asks this process. |
| **Local room** | A room that exists only on this laptop, driven by the user's own Claude Code, until they choose to publish it. |
| **Publish** | Turning a local room into an ordinary room on the service, with people in it. |
| **Claude Code** | Anthropic's command-line coding agent, installed and signed in by the user. We drive it; we never sign in to it. |
| **Agent SDK** | Anthropic's library that starts Claude Code as a child process and talks to it. We use it only for that. |
| **Ordinal (`ord`)** | The position number of a message in its chat. On the service the server assigns it; in a local room the sync engine does. Never reused, never renumbered. |

---

## 1. What this doc decides

| Question | Decision | § |
|---|---|---|
| Who talks to Claude Code? | A new background process, the **agent runner**. It owns the Claude Code child processes and nothing else — no database, no credentials. | 5 |
| Where does a local room live? | **`accounts/<acc>/local-rooms.db`**, beside `account.db`. Not inside the replica. | 4 |
| Is it a replica? | **No.** It is the only copy. Nothing evicts it, nothing rebuilds it, only a person deletes it. | 4 |
| What does it look like on disk? | **The replica's room tables, column for column**, plus a few tables that only mean something locally. | 6 |
| One room view or two? | **One.** The view reads by *scope* (`local` or `workspace`) and never branches on it. Building it for local rooms builds it for synced rooms. | 11 |
| How does Claude fit into a room? | **One Claude session per chat**, one running turn per room. Claude is a member of the room like any agent. | 8, 9 |
| How do web pages fit? | A **page** is a room object like a chat is. Panels become typed: `?p=c:<chat>,w:<page>`. | 10 |
| How is a room published? | A saved, resumable job: upload blobs → `begin` → `batch`… → `commit`. IDs are kept, so a retry is safe and the URL barely changes. | 12 |
| Does Claude's own transcript go to the service? | **No** (unless the user opts in). The service gets the conversation, the code, and a handoff brief. | 12 |

---

## 2. The idea in one picture

```
   on the laptop                                          on the service
   ┌──────────────────────────────────┐    publish        ┌────────────────────────────────┐
   │  local room                      │ ────────────────▶ │  room                          │
   │   ├ default chat  ← Claude       │  1 conversation   │   history, imported in order   │
   │   ├ side chat     ← Claude       │  2 code           │   sandbox: repo at base+patch  │
   │   ├ page panel: localhost:5173   │  3 handoff brief  │   service agent takes over     │
   │   └ you, as admin                │                   │   people join                  │
   │  local-rooms.db = the only copy  │                   └───────────────┬────────────────┘
   └──────────────────────────────────┘                                   │ ordinary sync
                  ▲                                       ┌───────────────▼────────────────┐
                  │ fork (new local room, new session)    │  relayed.db  (a rebuildable    │
                  └────────────────────────────────────── │  copy, like every other room)  │
                                                          └────────────────────────────────┘
```

Two different things, connected by one step. Before publish, the laptop is the
truth. After publish, the service is. The room view is the same on both sides
because both sides are read the same way: a local SQLite query, served by the
sync engine.

---

## 3. Background: driving Claude Code from an app

This section records what was learned from reading T3 Code — an open-source
desktop app that drives Claude Code, Codex and others through one interface.
Everything here is verified against its source (`apps/server/src/provider/` in
that repository) rather than recalled.

### 3.1 The one trick: never touch the credentials

The app depends on Anthropic's Agent SDK, but uses it purely as a way to start
and talk to **the user's own installed `claude` binary**:

```ts
query({ prompt, options: { pathToClaudeCodeExecutable: '/Users/me/.local/bin/claude', … } })
```

The SDK starts that binary as a child process and exchanges JSON lines with it
over stdin/stdout. The binary reads its own sign-in from the macOS keychain or
`~/.claude/.credentials.json`. **The app never sees a token.** The subscription is
used by the CLI, as the CLI. There is no API key, no proxy, nothing to store and
nothing to leak.

### 3.2 Finding out who is signed in — without spending anything

To show "signed in as harsh@…, Max plan", the app starts a real session whose
prompt is a generator that **never yields**:

```ts
prompt: (async function* () { await waitForAbort(signal); })()
```

The CLI finishes its local start-up handshake — account email, plan name, how it
was signed in, the list of slash commands — and hands that back through
`initializationResult()`. **No request ever reaches Anthropic**, because no
message was ever sent. Then the app aborts the child.

The probe is deliberately blunted so it can run on a timer:

| Option | Why |
|---|---|
| `persistSession: false` | Do not write a transcript file for a session that had no messages |
| `allowedTools: []` | Nothing could run even if a prompt got through |
| `settings: { disableAllHooks: true }` | **Otherwise the user's `SessionStart` hooks fire every few minutes** |
| `mcpServers: {}` + `strictMcpConfig: true` | Do not start the user's MCP servers for a health check |
| env `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `CLAUDE_CODE_AUTO_CONNECT_IDE=0` | Same idea, for the parts not covered by settings |

A separate, cheaper probe runs `claude --version` in an ordinary child process.
Together they distinguish three states the screen must never merge:
**not installed**, **installed but signed out**, **ready**.

### 3.3 Running a conversation

One Claude Code child process per conversation, kept alive between messages.
The prompt is an *async iterable fed from a queue*: each time the user sends
something, one more message is pushed into the queue and the child picks it
up. That is what makes "send another message while it is still working" work
without a restart.

The options that matter:

| Option | What it buys |
|---|---|
| `systemPrompt: { type: 'preset', preset: 'claude_code', append: '…' }` | Keeps Claude Code's real system prompt; appends two lines saying where it is running |
| `settingSources: ['user', 'project', 'local']` | The user's own `CLAUDE.md`, settings, hooks, skills all apply. Most of what makes it feel like *their* Claude Code |
| `includePartialMessages: true` | Text arrives token by token instead of per message |
| `cwd` | The directory the conversation is about. **Always chosen by the person**, never defaulted |
| `permissionMode` | See §3.4 |
| `sessionId` / `resume` | See §3.5 |
| `env: { …, CLAUDE_CONFIG_DIR }` | See §3.6 |

Every message from the child is one of a small set of types — `assistant`,
`user` (tool results), `result` (end of turn), `system` (init, compaction,
hooks, sub-tasks), `stream_event` (deltas), `rate_limit_event`, `auth_status`.
The app translates these into its own small vocabulary and throws the rest away.

### 3.4 Approvals

The SDK takes a `canUseTool(toolName, input, { signal, suggestions })`
callback. Claude Code calls it before running a tool and waits for the answer.
T3 Code's version, in plain words:

1. If the room is in "full access" mode, return **allow** at once.
2. Otherwise write an "approval requested" event, hold a promise, and wait.
3. When the person taps a button, resolve the promise with **allow** or **deny**.
4. "Allow for this session" passes the SDK's own `suggestions` back as
   `updatedPermissions`, so the CLI remembers it the way `claude` itself would.

Two tools get special treatment because they are really questions to the user:

- **`AskUserQuestion`** becomes a question card. The answer's key **must be the
  full question text** — the SDK looks answers up by it.
- **`ExitPlanMode`** — the app captures the plan text, shows it, and returns
  *deny* with a message telling Claude to stop and wait for feedback. Approving a
  plan becomes an app action rather than a CLI one.

The four permission modes map straight onto the SDK: supervised → no mode (every
tool goes through `canUseTool`), accept-edits → `acceptEdits`, auto → `auto`,
full access → `bypassPermissions` plus `allowDangerouslySkipPermissions: true`.

### 3.5 Continuing later

Claude Code writes its own transcript to
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (verified in Anthropic's
sessions guide). To continue a conversation after the app restarts, the app
keeps three things per conversation:

```json
{ "sessionId": "5b3f2c1a-…", "resumeAt": "<uuid of the last assistant message>", "turnCount": 7 }
```

and starts the next child with `resume: sessionId`. One rule worth copying: the
CLI emits placeholder session ids early in start-up, so the app only adopts a
`session_id` once it appears on a message that is actually durable.

Two more options matter for §9: `forkSession: true` starts a *new* session that
begins as a copy of an existing one, and `resumeSessionAt: <message uuid>`
resumes from a point in the middle. Anthropic's TypeScript reference lists both;
whether they combine is one of the spikes in §13.

### 3.6 Things that will bite

**`CLAUDE_CONFIG_DIR`, never `HOME`.** To point Claude Code at a different config
folder (a second account, or an isolated one), set `CLAUDE_CONFIG_DIR`. Setting
`HOME` instead also moves `$HOME/Library/Keychains`, so the child cannot find its
own sign-in and reports "Not logged in". T3 Code learned this the hard way and
left a comment; we should not learn it again.

**PATH in a packaged app.** An Electron app launched from Finder or the Dock
gets launchd's PATH — roughly `/usr/bin:/bin:/usr/sbin:/sbin` — not the user's
shell PATH. `claude` usually lives in `~/.local/bin` or a Homebrew prefix. So
`pnpm dev` (which inherits the shell) will work, and the packaged app will say
"not installed" for every user. Binary resolution must be explicit: probe known
locations, allow an override in settings, and **show the resolved path on the
settings screen** so a support conversation is one screenshot.

**Interrupt means close.** T3 Code stops a conversation by closing the query,
not by calling `interrupt()`, because interrupt can be acknowledged while
background tasks keep the child alive. The SDK then closes stdin and escalates
SIGTERM → SIGKILL.

**The child dies with its parent.** If the agent runner crashes, its Claude Code
children die too. That is fine *because* every conversation is resumable by
session id (§3.5). Durable intent, recoverable work — the same property the
outbox has.

### 3.7 The rule about subscriptions, and the name

Anthropic's Agent SDK overview says, in a note: *"Unless previously approved,
Anthropic does not allow third party developers to offer claude.ai login or rate
limits for their products, including agents built on the Claude Agent SDK."*
Letting a person run relayed on their Pro or Max plan is that. T3 Code does it;
that is not the same as it being allowed.

Two ways forward, and the design does not change between them:

- **Ask Anthropic for approval.**
- **Bring your own API key.** The child reads `ANTHROPIC_API_KEY` from the
  environment we hand it, and nothing else in this document changes.

On naming, from the same page: a product may say **"Claude Agent"** or
**"Powered by Claude"**, and may **not** say "Claude Code" or imitate its look.
This document says "Claude Code" when it means the tool; the product's screens
say "Claude Agent".

---

## 4. Where a local room lives, and why it is not a replica

```
userData/
  install-id
  accounts/
    acc_01M215K8QW…/
      account.db                         device id, workspace index, preferences
      local-rooms.db                     ← NEW. Local rooms. The only copy.
      local-blobs/                       ← NEW. Screenshots, attachments for local rooms
      auth/…
      workspaces/
        wsp_…/relayed.db                 a replica — the server can rebuild it
```

**Why the account tier.** A local room is about a directory on this machine and
the person who opened it. It is not about a workspace — until the moment it is
published *into* one. Placing it beside `account.db` means:

- switching workspaces does not touch it (a workspace switch replaces the replica
  underneath every open read — the epoch rule in `STORAGE.md`, *the epoch*, §12.1;
  a running Claude turn must not be torn down because someone clicked a
  different workspace);
- signing out of a workspace does not delete it;
- a second account on the same machine cannot see it.

**Why not inside `relayed.db`.** Everything in the replica is built on the promise
that the server holds the truth: retention may evict old messages, removing a
workspace deletes the file, and `main/index.ts` calls the whole thing
"recoverable, since it is a replica". A local room has no server copy. Putting it
there makes it data the app is entitled to throw away. Two concrete ways the
existing code would break it today:

1. **`applyWelcome` deletes every membership row for the signed-in actor and
   rewrites them from the server's list** (`sync/storage.ts`). The server has
   never heard of a local room, so its author would lose admin on their own room
   at every reconnect.
2. **Exactly one workspace replica is active at a time** (`STORAGE.md`, *the
   active-workspace rule*). A Claude turn running while the user is in another
   workspace would have nowhere to write.

So the local store **copies the replica's shape** (§6) and makes a **different
promise**: never evicted, never rebuilt, deleted only by an explicit action.

---

## 5. The processes

```
 main (thin)          renderer (the window)        sync engine               agent runner   ← NEW
 ├ spawns both   ←──  one MessagePort ──────→      owns every database  ←──  MessagePort ──→
 ├ respawns on exit   useQuery / call              relayed.db, account.db,   one Claude Code child
 ├ brokers ports                                   local-rooms.db            per open chat
 └ owns web page views (§10)                       sole writer, sole reader  no database, no secrets
```

The **agent runner** is a second `utilityProcess`, built from
`src/agent-runner/index.ts` as a third entry in `electron.vite.config.ts`. Two
reasons it is its own process, both already argued for the sync engine in
`DESIGN.md` (*why a utility process rather than the main process*, §5):

- `node:sqlite` is synchronous. A stream of partial messages arriving thirty
  times a second must not share a thread with catch-up writes and the 30-second
  heartbeat.
- The agent runner is the part that gets restarted — long runs, a stalled
  provider, a child that will not die. It should be killable without dropping
  the socket.

**It owns no database.** One writer per SQLite file is the rule that `main/index.ts`
already enforces with the single-instance lock. The runner sends small events to
the sync engine; the sync engine writes rows and tells the screen what changed,
exactly as it does for events arriving on the socket. The runner is, to the sync
engine, *another socket*.

**It holds no credential.** No vault access, no session token, no database
handle, no idea which workspace is open. It receives a directory and a binary
path. This is the same rule `AGENT-RUNTIME.md` (*the bash problem*, §4) sets
for the service runtime, for the same reason.

**Main brokers the port** the same way it already does for the renderer: on
start, main creates a `MessageChannelMain` and hands one end to each process.
Main is then out of the hot path.

---

## 6. The local store

`local-rooms.db`. The first three tables are **the replica's tables, column for
column**, taken from `sync/migrations/workspace.ts` — not from `DESIGN.md`, which
differs in small ways from what was built. Copying the built shape is what lets
one room view read either store without a translation layer.

```sql
PRAGMA auto_vacuum = INCREMENTAL;   -- first, before anything else (DESIGN.md §13.5)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Copied from the replica ────────────────────────────────────────────────
-- `spaces`, `chats`, `memberships`, `messages`: identical DDL to the replica,
-- including every CHECK and index. Two differences, both widenings:
--
--   messages.ord    is NOT NULL here. There is no "pending" in a local room —
--                   the sync engine assigns the ordinal on insert.
--   messages.state  CHECK (state IN ('streaming','acked','failed'))
--                   `streaming` is the row Claude is still writing (§8.3).
--
-- `workspace_id` is present because the columns are copied; it holds the
-- constant 'local' until publish fills in the real one.

-- ── The two actors a local room can contain ─────────────────────────────────
-- Fixed ids. A local room has no directory to replicate: it is you and your
-- agent. At publish both are mapped to real actors in the target workspace (§12.5).
CREATE TABLE actors (                -- same columns as the replica's actors
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL,
  handle TEXT NOT NULL, display_name TEXT NOT NULL,
  avatar_url TEXT, avatar_blob TEXT, owner_actor_id TEXT,
  state TEXT NOT NULL, updated_at INTEGER NOT NULL
);
INSERT INTO actors VALUES
  ('act_local_me',    'local', 'human', 'me',    'You',          NULL, NULL, NULL,           'active', 0),
  ('act_local_agent', 'local', 'agent', 'agent', 'Claude Agent', NULL, NULL, 'act_local_me', 'active', 0);

-- ── Local-only tables. No replica counterpart. ──────────────────────────────

-- What makes a space a LOCAL room: the directory, and where it is in its life.
CREATE TABLE local_rooms (
  space_id        TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  cwd             TEXT NOT NULL,          -- chosen by the person, shown in the header
  mode            TEXT NOT NULL,          -- 'supervised'|'accept-edits'|'auto'|'full-access'
  publish_state   TEXT NOT NULL DEFAULT 'local',
                                          -- 'local'|'publishing'|'published'|'publish_failed'
  workspace_id    TEXT,                   -- set the moment a publish starts
  published_at    INTEGER,
  CHECK (publish_state IN ('local','publishing','published','publish_failed'))
);

-- One Claude Code session per chat (§8.1). This is the resume cursor of §3.5.
CREATE TABLE chat_sessions (
  chat_id      TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  session_id   TEXT,                      -- Claude Code's own id, once durable
  resume_at    TEXT,                      -- uuid of the last assistant message
  turn_count   INTEGER NOT NULL DEFAULT 0,
  forked_from  TEXT,                      -- chat id this session was forked from, if any
  updated_at   INTEGER NOT NULL
);

-- What Claude did inside one message: tool calls, their results, the plan it
-- proposed. JSON, because its shape is Claude's and changes with Claude.
-- `messages.body` ALWAYS holds a readable rendering of the same turn, so a
-- client that does not understand `parts` still shows something (§8.4).
CREATE TABLE message_parts (
  message_id  TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  parts       TEXT NOT NULL,              -- JSON array, see §8.4
  updated_at  INTEGER NOT NULL
);

-- A question Claude is waiting on. One row while open; deleted when answered.
CREATE TABLE approvals (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL,              -- the streaming row it belongs to
  kind        TEXT NOT NULL,              -- 'tool'|'question'|'plan'
  payload     TEXT NOT NULL,              -- JSON: tool name + input, or the questions, or the plan
  opened_at   INTEGER NOT NULL,
  CHECK (kind IN ('tool','question','plan'))
);

-- A web page pinned in the room (§10). The replica gains the identical table
-- when synced rooms get pages.
CREATE TABLE pages (
  id                  TEXT PRIMARY KEY,
  space_id            TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  url                 TEXT NOT NULL,
  title               TEXT,
  created_by_actor_id TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX page_space ON pages(space_id);

-- A publish in progress (§12.2). One row per attempt, kept for the audit trail.
CREATE TABLE publish_jobs (
  space_id     TEXT NOT NULL REFERENCES spaces(id),
  op_id        TEXT PRIMARY KEY,          -- the idempotency key the server dedupes on
  workspace_id TEXT NOT NULL,
  stage        TEXT NOT NULL,             -- 'preflight'|'uploading'|'begun'|'batching'|'committed'|'failed'
  imported_through_ord TEXT,              -- JSON {chatId: ord}, from the server's reply
  blobs        TEXT,                      -- JSON {bundle, patch, images[]} → uploaded blob ids
  error        TEXT,
  started_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
```

**Why copy rather than reference.** The alternative — a `drafts` table with its
own shape — is exactly what would make the room view fork into two. Every column
the view reads exists in both stores with the same name and meaning. If the
local side ever wants a field the replica cannot produce, that field goes into
the replica's design too, or it does not go in.

---

## 7. Creating a local room, step by step

The person clicks **New local room** and picks a folder; the room is named as it is used (§7.1). Here is
what happens, with the rows it produces. IDs are the app's usual prefixed random
ids from `sync/ids.ts`, shortened here for reading.

**Step 1 — the screen asks the sync engine.**

```json
→ { "id": 41, "op": "local.rooms.create",
    "params": { "name": "Fix the flaky sync test", "cwd": "/Users/harsh/Documents/Git/personal/relayed" } }
```

**Step 2 — the sync engine writes four rows in one transaction.** Same shape a
room would arrive in from the server, so the sidebar and the room view do not
know the difference.

```sql
INSERT INTO spaces (id, workspace_id, kind, name, slug, visibility, membership_policy,
                    lifecycle, created_by_actor_id, last_activity_at, created_at, updated_at)
VALUES ('spc_7Q2M4K', 'local', 'room', 'Fix the flaky sync test', 'fix-the-flaky-sync-test',
        'private', 'invite', 'active', 'act_local_me', 1789000000000, 1789000000000, 1789000000000);

-- The room's shared floor. `chat_singleton` guarantees there is exactly one.
INSERT INTO chats (id, workspace_id, space_id, kind, name, created_by_actor_id, created_at, updated_at)
VALUES ('cht_K9XV3N', 'local', 'spc_7Q2M4K', 'default', NULL, 'act_local_me', 1789000000000, 1789000000000);

-- You are the admin; the agent is a member. Same rows a synced room would hold,
-- so the shared `can()` answers "may I rename this room?" the same way.
INSERT INTO memberships VALUES ('space', 'spc_7Q2M4K', 'act_local_me',    'admin',  1789000000000, NULL);
INSERT INTO memberships VALUES ('space', 'spc_7Q2M4K', 'act_local_agent', 'member', 1789000000000, NULL);

-- The part that makes it LOCAL.
INSERT INTO local_rooms (space_id, cwd, mode)
VALUES ('spc_7Q2M4K', '/Users/harsh/Documents/Git/personal/relayed', 'supervised');

-- A session row with no session yet. Claude Code is not started until the
-- first message — starting it here would run the user's hooks for a room
-- that may never be used.
INSERT INTO chat_sessions (chat_id, updated_at) VALUES ('cht_K9XV3N', 1789000000000);
```

**Step 3 — the sync engine tells the screen what changed**, using the same
invalidation push it uses for everything else, on a topic that names the local
scope:

```json
← { "push": "invalidate", "data": { "invalidation": 118, "topics": ["local:spaces"] } }
```

**Step 4 — the screen navigates** to `#/local/s/spc_7Q2M4K`. The room view
mounts, resolves the space to its default chat with the same lookup a synced room
uses (the unique `chat_singleton` index), and renders an empty chat with a
composer. The header shows the folder path, because a room about a directory
should say which one.

Nothing has been spawned yet. Total cost: four rows and one push.

---

### 7.1 Naming a room

A room is not named after its folder: the folder is already the group it sits
under in the sidebar. It is named by what is said in it, the way t3code names
threads. Each step is its own function in `sync/local/titles.ts`, so a setting
can switch automatic naming off without touching rename:

| Step | When | What |
|---|---|---|
| **New room** | created | The default name |
| **Seed** | the person's first message in the room | That message, whitespace flattened, cut to 50 characters. Free and instant |
| **Generate** | in the background, right after the seed | `claude-haiku-4-5` names it from the first message: 3–8 words, under 40 characters. Written only if the room is still called the default or the seed, checked in the same `UPDATE`. Two retries with backoff; on failure the seed stays |
| **Regenerate** | the person asks (sidebar context menu) | From the conversation — the latest 8,000 characters, with the first message pinned — and the current name. A copy of the current name is discarded |
| **Rename** | double-click the row, or its context menu | What they typed, clamped. Always wins |

Generation runs through the runner's `text.generate`: the person's own Claude
Code with no tools, no MCP servers, no hooks, no project and no transcript. It
does send a request, so it spends a little of their usage — the one step here
that is not free. `TitlePolicy` (`seedFromFirstMessage`, `generateFromFirstMessage`)
is where a preference plugs in.

## 8. A conversation in a chat

### 8.1 One Claude session per chat

Every chat in a local room has its own Claude Code session — its own child
process while open, its own transcript on disk, its own resume cursor in
`chat_sessions`. The chat is the unit of context here for the same reason it is
the unit of sync everywhere else: it is the thing a person reads top to bottom.

One rule on top: **one running turn per room at a time.** Every chat in the
room works on the same directory, and two Claude sessions editing one working
tree at once is a way to get a half-applied change. The agent runner keeps a
per-room lock; a message sent to a second chat while the first is busy is
queued and shown as "waiting for the other chat". The service will need the
same lock for the same reason, so the rule is stated once.

### 8.2 Sending the first message

```json
→ { "id": 42, "op": "messages.send",
    "params": { "scope": "local", "chatId": "cht_K9XV3N", "body": "Why does sync/catchup.test.ts flake?" } }
```

The sync engine, in one transaction, writes the human's message and an empty
row for the reply Claude is about to write:

```sql
INSERT INTO messages (id, chat_id, parent_id, ord, rev, author_id, body, created_at, state)
VALUES ('msg_A1', 'cht_K9XV3N', NULL, 1, NULL, 'act_local_me',
        'Why does sync/catchup.test.ts flake?', 1789000010000, 'acked');

INSERT INTO messages (id, chat_id, parent_id, ord, rev, author_id, body, created_at, state)
VALUES ('msg_A2', 'cht_K9XV3N', NULL, 2, NULL, 'act_local_agent', '', 1789000010001, 'streaming');
```

then invalidates `local:chat:cht_K9XV3N:messages` and asks the agent runner to
start or continue the session:

```json
→ runner { "type": "turn.start", "roomId": "spc_7Q2M4K", "chatId": "cht_K9XV3N",
           "replyMessageId": "msg_A2",
           "cwd": "/Users/harsh/Documents/Git/personal/relayed", "mode": "supervised",
           "session": { "sessionId": null, "resumeAt": null },
           "text": "Why does sync/catchup.test.ts flake?" }
```

The runner has no session for this chat, so it starts one:

```ts
query({
  prompt: queueAsAsyncIterable,                       // §3.3
  options: {
    pathToClaudeCodeExecutable: resolvedClaudePath,   // §3.6, resolved explicitly
    cwd: '/Users/harsh/Documents/Git/personal/relayed',
    sessionId: 'c1f0…-…',                             // we mint the uuid, so the cursor is known up front
    systemPrompt: { type: 'preset', preset: 'claude_code', append: RUNTIME_NOTE },
    settingSources: ['user', 'project', 'local'],
    includePartialMessages: true,
    canUseTool,                                       // §8.5
    env: { ...process.env, PATH: resolvedPath },      // no CLAUDE_CONFIG_DIR unless the user set one
  },
})
```

and pushes the text into the queue. The child starts, and messages begin to
flow back.

### 8.3 The streaming row

This is the local twin of the replica's **pending** row — a row that exists
before the thing it represents is final — and it is handled the same way so the
room view learns one rule, not two.

| Phase | What the runner sends | What the sync engine does |
|---|---|---|
| Text arrives | `{ type: 'text.delta', chatId, messageId: 'msg_A2', text: 'The test races ' }` | **Does not write it.** Forwards it straight to the screen on the `agent:stream` push, coalesced per animation frame |
| A tool starts | `{ type: 'tool.started', messageId, toolUseId, name: 'Read', input: {…} }` | Appends a part to `message_parts`, invalidates `local:chat:…:messages` |
| A tool ends | `{ type: 'tool.done', toolUseId, ok: true, output: '…', ms: 41 }` | Updates that part; invalidates |
| Turn ends | `{ type: 'turn.completed', messageId, text: '<full final text>', usage: {…}, session: { sessionId, resumeAt, turnCount } }` | Rewrites `msg_A2`: `body = text`, `state = 'acked'`; updates `chat_sessions`; invalidates |
| Turn fails | `{ type: 'turn.failed', messageId, reason: 'usage limit reached — resets in 2h 10m' }` | `state = 'failed'`, `body` = whatever text arrived, reason stored in parts |

**Why deltas skip the database.** The read path is built on coarse invalidation
because computing a diff is expensive (`DESIGN.md`, *coarse invalidation, not
diffing*, §11.2). A token delta is the opposite case: it *is* the diff, already
computed. Writing it, invalidating, and having the screen re-read a growing
message thirty times a second is the waste that rule exists to avoid. So deltas
ride an ephemeral push, keyed by message id, and are dropped when no window is
attached. A screen that mounts mid-turn reads the `streaming` row (empty or
partial) and catches up from the next delta. **A lost delta is cosmetic by
construction**, because the final text always arrives in `turn.completed`.

The push, as the screen sees it:

```json
← { "push": "agent:stream", "data": { "messageId": "msg_A2", "text": "The test races the\nmock socket's close event" } }
```

Only completed rows persist. After the turn, the row reads:

```sql
-- messages
('msg_A2', 'cht_K9XV3N', NULL, 2, NULL, 'act_local_agent',
 'The test races the mock socket''s close event: `catchup()` resolves before …', 1789000010001, 'acked')
-- chat_sessions
('cht_K9XV3N', 'c1f0…', '9d7e…-…', 1, NULL, 1789000041000)
```

### 8.4 Tool calls live inside the message, not beside it

> **Superseded for the part shapes** by [`AGENT-RESPONSES.md`](AGENT-RESPONSES.md),
> the message contract: parts are stored with the message, gain a `ui` kind, and
> `body` is derived. The reasoning below — one turn is one message — still holds.

A single Claude turn can call a hundred tools. Each one must **not** become its
own message: ordinals, unread counts, and paging all count messages, and a room
whose history is 90% `Read` calls is unreadable and un-pageable. So one turn is
one message, and the tool calls are its **parts**:

```json
// message_parts.parts for msg_A2
[
  { "kind": "text",  "text": "Let me look at the test." },
  { "kind": "tool",  "toolUseId": "toolu_01", "name": "Read", "ok": true,  "ms": 41,
    "input": { "file_path": "apps/desktop/src/sync/catchup.test.ts" },
    "outputPreview": "import { test } from 'node:test'…", "outputBytes": 8123 },
  { "kind": "tool",  "toolUseId": "toolu_02", "name": "Bash", "ok": true,  "ms": 2210,
    "input": { "command": "node --test apps/desktop/src/sync/catchup.test.ts" },
    "outputPreview": "# pass 11\n# fail 1 …", "outputBytes": 1904 },
  { "kind": "text",  "text": "The test races the mock socket's close event: …" }
]
```

`messages.body` is the readable rendering of the same turn — the text parts
joined, with a one-line summary where each tool ran (`▸ Read
apps/desktop/src/sync/catchup.test.ts`). Two reasons for keeping both:

- **Search, publish, and old clients read `body`.** A client that does not know
  what `parts` is still shows a sensible message.
- **The screen reads `parts`** to render collapsible tool cards, exactly as it
  will for the service agent later.

Large tool output is truncated in `parts` (`outputPreview` + `outputBytes`); the
full output is not kept. Claude Code's own transcript has it if anyone needs it.

### 8.5 Approvals, questions, plans

In `supervised` mode, before Claude runs `Bash`, the SDK calls `canUseTool`. The
runner sends:

```json
→ sync { "type": "approval.requested", "chatId": "cht_K9XV3N", "messageId": "msg_A2",
         "approvalId": "apr_M4K9", "kind": "tool",
         "payload": { "name": "Bash", "input": { "command": "node --test …" }, "summary": "Run `node --test …`" } }
```

The sync engine inserts an `approvals` row and invalidates
`local:chat:cht_K9XV3N:approvals`. The room view, which subscribes to that
topic, renders a card with **Allow**, **Allow for this session**, **Deny**. The
person taps Allow:

```json
→ { "id": 43, "op": "local.approvals.respond",
    "params": { "chatId": "cht_K9XV3N", "approvalId": "apr_M4K9", "decision": "allow" } }
```

The sync engine deletes the row, invalidates, and forwards the decision to the
runner, which resolves the promise `canUseTool` is waiting on. Claude runs the
command.

**`AskUserQuestion`** takes the same path with `kind: 'question'` and the
questions in `payload`; the answer is keyed by the question text (§3.4).
**`ExitPlanMode`** takes it with `kind: 'plan'`; the plan markdown is also
written as a part so it stays visible in the transcript after the decision.

If the app quits with an approval open, the child dies, the row is deleted at
next boot, and the message is marked `failed` with reason "interrupted". Nothing
can be left waiting on a question nobody can see.

**Allow for this session** returns Claude Code's own suggested rule with its
destination rewritten to `session`: approving in a chat never writes to the
person's `settings.json`. A mode change reaches a live child through
`setPermissionMode` from its next tool call; moving into full access needs a
child started with `allowDangerouslySkipPermissions`, so an idle child is closed
at once and a busy one after its turn, and the next message resumes it.

### 8.6 Everything else a chat can do

Edit, delete, react — the same ops as a synced chat, applied to the local store
directly (there is no outbox to go through). Deleting a message is a tombstone
here too: the ordinal stays taken, so a gap the screen cannot explain never
appears (`DESIGN.md`, *ord is never renumbered or reused*, §8.1).

### 8.7 Slash commands

The composer offers the person's own Claude Code commands — built in, theirs,
the project's, skills and plugins — when a message starts with `/`.

**The list** is per folder, from the same unused start-up handshake as the status
check (`claude.commands`), started in the room's folder with user, project and
local settings so the project's own commands appear. It spends nothing. The sync
engine keeps it for five minutes and replaces it whenever a live session pushes
`commands_changed`. A read never waits: the first returns nothing and the answer
arrives as an invalidation of `local:commands`. Measured in this repo: 306
commands, most of them plugin skills.

**Hidden** (`shared/slash-commands.ts`): the terminal-only ones Claude Code still
lists in an SDK session — `/config`, `/doctor`, `/heapdump`, `/color` and similar.

**Run by Relayed**, never sent:

| Command | What it does |
|---|---|
| `/model [name]` | Sets the room's model if the name matches one listed, else opens the picker |
| `/effort [level]` | Sets the room's effort, `default` clears it, else opens the picker |
| `/clear` | Forgets the chat's session (`chat_sessions.session_id = NULL`), closes the child, and notes it in the chat; refused while Claude is replying |
| `/rename [name]` | Renames the room, or regenerates its name (§7.1) |

**Everything else** is sent as the message it is; Claude Code reads a message
that starts with `/` as a command. Measured: `/context` and `/usage` answer as an
ordinary assistant text block followed by a `result`, at no cost, so they end the
turn like any reply. Output that arrives as `local_command_output` is kept as a
fenced block with colour codes stripped, and a `compact_boundary` becomes a
"Context compacted: 120k → 18k tokens" line.

---

## 9. Starting a new chat in a room

Exactly as in a synced room: the room header's **New chat** button, a name, and
optionally **private**. What differs is only what the new chat's Claude session
starts from.

**Step 1 — the ask.**

```json
→ { "id": 51, "op": "local.chats.create",
    "params": { "spaceId": "spc_7Q2M4K", "name": "try a different fix", "kind": "public",
                "startFrom": { "type": "fork", "chatId": "cht_K9XV3N" } } }
```

`startFrom` is one of:

| `startFrom` | The new chat's Claude session | When you want it |
|---|---|---|
| `{ type: 'fresh' }` | A brand-new session in the same directory | A separate question about the same code |
| `{ type: 'fork', chatId }` | `resume: <that chat's sessionId>, forkSession: true` — starts with a copy of that chat's whole context | "Try another approach without losing this one" |

**Step 2 — the rows.**

```sql
INSERT INTO chats (id, workspace_id, space_id, kind, name, created_by_actor_id, created_at, updated_at)
VALUES ('cht_P3RT8W', 'local', 'spc_7Q2M4K', 'public', 'try a different fix', 'act_local_me', 1789000100000, 1789000100000);

INSERT INTO chat_sessions (chat_id, forked_from, updated_at)
VALUES ('cht_P3RT8W', 'cht_K9XV3N', 1789000100000);
-- session_id stays NULL until the first message: the fork happens when the
-- child starts, not when the chat is created.
```

A **private** chat additionally writes a chat-level membership row for
`act_local_me` — the same row a private chat in a synced room has. There is
nobody to hide it from yet, but it publishes as private without any conversion,
because the row already says so.

**Step 3 — invalidate `local:space:spc_7Q2M4K`** so the room's chat list
repaints, and navigate to `#/local/s/spc_7Q2M4K/c/cht_P3RT8W` — the new chat in
the main pane — or `#/local/s/spc_7Q2M4K?p=c:cht_P3RT8W` to open it beside the
default one. Both are the synced room's URLs with a different prefix.

**Step 4 — first message in the new chat** goes through §8.2 unchanged, except
the runner starts the child with:

```ts
resume: 'c1f0…',        // the default chat's session
forkSession: true,      // …copied into a new one, whose id arrives on the init message
```

and adopts the new session id into `chat_sessions.session_id` once it is durable.

### 9.1 Threads

A thread is replies under one message, in its own pane (`?t=msg_A2`). In a
local room a thread on an **assistant** message is the natural place to ask
"why did you do *that*?" — and the honest way to answer is a Claude session that
knows everything up to that message and nothing after.

That is `resume: sessionId, resumeSessionAt: <that message's Claude uuid>,
forkSession: true`. The runner records the Claude uuid of each assistant message
in its part (`{ kind: 'text', … }` carries `uuid`), so the thread's session can
be pinned to the right point. Whether those three options combine is a spike
(§13.1); until it is proven, threads on assistant messages fork from the end of
the session instead, which is still useful and needs no new mechanism.

Thread replies are ordinary `messages` rows with `parent_id = 'msg_A2'`, exactly
as in a synced chat.

---

## 10. Panels

### 10.1 Chats as panels — nothing new

`?p=` already opens a room's chats beside the main pane (`FRONTEND.md`, *panes
are query, not path*, §4.7). A local room uses it unchanged:

| URL | Shows |
|---|---|
| `#/local/s/spc_7Q2M4K` | The default chat |
| `#/local/s/spc_7Q2M4K?p=c:cht_P3RT8W` | Default chat, with "try a different fix" beside it |
| `#/local/s/spc_7Q2M4K/c/cht_P3RT8W?t=msg_B7` | "try a different fix" as the main pane, a thread open |

### 10.2 Panels become typed

That same section says `?p=` carries chat ids, and that if panels ever hold
something that is not a chat, it "becomes a discriminated segment". A web page
is that something. The segment is a one-letter kind and an id:

```
?p=c:cht_P3RT8W,w:pg_H2V6
   └ a chat     └ a page
```

The renderer keeps a small registry from kind → component (`c` → chat panel,
`w` → page panel). A future kind (a canvas, a live agent-run view) is a new entry
in that registry and touches nothing else. A bare id with no kind keeps meaning
a chat, so existing links keep working.

### 10.3 A page is a room object

```sql
INSERT INTO pages (id, space_id, url, title, created_by_actor_id, created_at, updated_at)
VALUES ('pg_H2V6', 'spc_7Q2M4K', 'http://localhost:5273/#/w/wsp_1/s/spc_9', 'Relayed (dev)',
        'act_local_me', 1789000200000, 1789000200000);
```

The page belongs to the room and travels with it (§12). **What is open** is in
the URL. **Where the person has browsed to inside it** is neither: navigating
inside a page panel is device-local view state and is never written anywhere.
Otherwise one click would change the page for everyone in a synced room, and
every navigation would be a write. Changing the *pinned* URL is a deliberate
action with its own button.

The strongest local use is obvious once it exists: Claude editing code in the
main chat, the app under test running in a page panel beside it.

### 10.4 Rendering a real web page inside the window

Three ways exist, and Electron's own guidance rules out two:

| Way | Verdict | Why |
|---|---|---|
| `<iframe>` | No | Most sites refuse to be framed; the renderer's CSP would have to be loosened; a heavy page shares the app's process |
| `<webview>` tag | No | Electron's web-embeds guide says "we do not recommend you to use WebViews" and points at the alternative below |
| **`WebContentsView`** | **Yes** | A native view with its own process, layered into the window by main. Electron's guide: it "exists outside the DOM", so main and renderer coordinate its position |

**How it works.** The renderer renders an empty panel and measures it with a
`ResizeObserver`. Every change of size, position, or visibility is sent to main
as `{ key, url, bounds, visible }`. Main owns a `WebContentsView` per key, calls
`setBounds`, and reports back `{ key, title, loading, canGoBack }`. Main holds
**no room data** — it knows keys, URLs and rectangles, which keeps it as thin as
the process design requires.

**Security, stated as settings:**

| Setting | Why |
|---|---|
| Its own session partition, `persist:pages:<acc>` | A page must never see the app's cookies or origin. Per account, so two accounts' logins do not mix |
| `sandbox: true`, `contextIsolation: true`, no `nodeIntegration`, **no preload** | The page is untrusted content |
| `setWindowOpenHandler` → system browser | A page cannot open windows inside the app |
| Navigation to `file:`, `relayed:`, `relayed-blob:` refused | A page cannot reach the app's own schemes |
| Permission requests denied (camera, mic, location, notifications) | Until there is a reason to ask the person |
| Downloads prompt first | A page cannot write to disk silently |

**The overlay problem — the one thing that needs a spike before this is
promised.** A native view draws *above* the window's HTML. Menus, popovers,
the command palette, toasts and dialogs cannot appear over it. The intended
fix: whenever any overlay opens, and while a panel or the sidebar is being
dragged (bounds updates trail the drag), hide the view and show a
`capturePage()` snapshot in its place. Whether that is smooth enough is a
measurement, not an opinion (§13.1).

**Lifecycle.** Closing a panel hides its view rather than destroying it, and a
small least-recently-used set of hidden views is kept, so reopening a page does
not reload it or lose a login. The set is capped, because every view is a
renderer process.

---

## 11. One room view, two scopes

### 11.1 The read contract, shared

A synced room is *already* a local read: the renderer never touches the network;
it asks the sync engine, which reads SQLite. The only difference between a local
room and a synced one is **who writes the rows** — the agent runner or the
socket's apply loop. A room view built against the read contract cannot tell
them apart. That is why building it for local rooms builds it for synced rooms.

What makes that true in practice:

- **One query name, a `scope` argument.** Every room read takes
  `{ scope: 'local' } | { scope: 'workspace', workspaceId }`, read from the URL
  by one `useRoomScope()` hook. Components receive rows; they never branch on
  scope.
- **One row type per table**, the ones in `preload/api.d.ts`, extended once for
  `state: 'streaming'` and an optional `parts`.
- **Topics carry the scope.** `local:chat:<id>:messages` beside
  `chat:<id>:messages`. A topic names what a writer changed, and there are two
  writers now; a separate root means the socket never wakes a local reader and
  the runner never wakes a synced one. `local` is a new top-level word in
  `shared/topics.ts`, which per that file's own note means it inherits no
  existing readers — correct, since it is genuinely new data.
- **"Who am I" comes from the scope.** `Chat.tsx` today reads it from the active
  workspace's actor. In a local room that is `act_local_me`.
- **Writes use the same op names**, with `scope`, and the sync engine routes
  them. A local `messages.send` writes and starts a turn; a synced one goes to
  the outbox.

### 11.2 Two rules that change

1. **The offline state.** `statusOf` in the live-query client reports `offline`
   when the network is down. A local room does not care; for `scope: 'local'`
   the answer is `live` whenever rows exist.
2. **The stale-reply rule.** The preload drops any reply whose epoch is older
   than the current one (invariant 41, *a reply for the workspace we have
   already left*). A local read is not workspace-scoped, so under that rule
   every workspace switch would silently discard in-flight local reads. Replies
   for local ops carry `scope: 'local'` and are exempt; they are dropped on an
   **account** switch instead, which is the boundary that actually applies to
   them. This is a small, deliberate amendment to the IPC contract and wants its
   own invariant beside 41 rather than a quiet edit to it.

### 11.3 Addressing

Paths follow storage tiers (`FRONTEND.md`, *the route table*, §4.6): anything
under `/w/:wsId` must be answerable from that replica; account-tier things sit
outside it. Local rooms are account-tier, so:

```
/local                          the list of local rooms
/local/s/:spaceId               ↔  /w/:wsId/s/:spaceId
/local/s/:spaceId/c/:chatId     ↔  /w/:wsId/s/:spaceId/c/:chatId
?a= ?t= ?ta= ?p=                identical in meaning
```

Publishing is then `navigate('/w/' + wsId + '/s/' + spaceId + location.search,
{ replace: true })`. Because chat, message and page ids are kept through
publish, **the open panel, the open thread and the scroll anchor survive it**.

### 11.4 What a local room cannot show you

Some states exist only on the synced path. If the room view is built without
ever rendering them, it will look finished and break on first contact with a
socket:

- pending, queued and failed messages;
- the gap marker and "load older";
- the offline state;
- unread and mention badges;
- an action the shared `can()` refuses;
- other people's messages, including the name-less monogram before the
  directory lands;
- a message that visibly moves when its ordinal arrives.

These get **fixtures**: the same room view mounted over hand-written rows in
those states, and then the real thing through `pnpm mock` and the dev offline
switch. The local room is where the view is *built*; the synced path is where it
is *proven*.

---

## 12. Publishing

Publishing turns the local room into an ordinary room in one workspace, with the
service running the agent from then on. It is the one operation in this
document that needs the network, and it is built like the outbox: **intent is
saved before anything is sent, every step can be retried, and nothing here ever
changes what the room contains — only what state it is in.**

### 12.1 Preflight — on the laptop, no network

Refused while a turn is running. Then, in order:

1. **Stop every Claude child** for the room. Sessions stay resumable; the person
   can fork later (§12.7).
2. **Capture the code**, if the directory is a git repository:
   - `HEAD`, the current branch, the remote URL;
   - a `git bundle` of any commits the remote does not have — without it the
     service cannot check out the base;
   - a binary diff of the working tree, **including untracked files that are
     not ignored** — new files are usually the point.
   A directory that is not a repository publishes its conversation only, and the
   review screen says so.
3. **Scan for secrets** in the patch and in every tool output part. A private
   key, a cloud credential or a `.env` file blocks the publish; the person can
   override each finding explicitly, and the override is recorded.
4. **Write the handoff brief.** One final *local* turn asks Claude: "Summarise
   for someone joining now: the goal, decisions made, files touched, what is
   left." The local Claude has the full context and is the best author; the
   person edits the result before anyone else reads it. It becomes the room's
   first message on the service.
5. **The review screen:** target workspace, room name, visibility (**private by
   default**), people to invite, message count, file count, base commit, the
   brief. A pinned page whose URL is `localhost` is flagged — it means nothing
   on the service. Attachments and screenshots are listed; the raw Claude
   transcript is **off by default** (it contains every file read and every
   command output).

### 12.2 Save the intent

Before any network call:

```sql
UPDATE local_rooms SET publish_state = 'publishing', workspace_id = 'wsp_01M213…' WHERE space_id = 'spc_7Q2M4K';
INSERT INTO publish_jobs (space_id, op_id, workspace_id, stage, started_at, updated_at)
VALUES ('spc_7Q2M4K', 'op_PUB01', 'wsp_01M213…', 'preflight', 1789001000000, 1789001000000);
```

From here a crash, a lost connection or a quit picks up where it left off at
next boot, using `stage` and `imported_through_ord`.

### 12.3 Upload the blobs

The bundle, the patch, and any images go through the existing two-phase blob
upload. Their blob ids are written to `publish_jobs.blobs`; `stage =
'uploading'` → `'begun'` only once all are confirmed.

### 12.4 `begin` — create the room, with our ids

Over HTTP, not the socket: this is bulk, and the socket has a frame-size rule for
a reason.

```json
POST /rooms/import/begin
{
  "opId": "op_PUB01",
  "workspaceId": "wsp_01M213…",
  "space":  { "id": "spc_7Q2M4K", "name": "Fix the flaky sync test", "visibility": "private" },
  "chats":  [ { "id": "cht_K9XV3N", "kind": "default", "name": null },
              { "id": "cht_P3RT8W", "kind": "public",  "name": "try a different fix" } ],
  "pages":  [ { "id": "pg_H2V6", "url": "http://localhost:5273/…", "title": "Relayed (dev)", "flagged": "loopback" } ],
  "code":   { "remote": "git@github.com:harsh/relayed.git", "branch": "main", "base": "4448d29…",
              "bundleBlob": "blob_…", "patchBlob": "blob_…" },
  "handoff": "## Goal\nMake catchup.test.ts stop flaking …",
  "origin": { "kind": "local_session", "cwd": "/Users/harsh/Documents/Git/personal/relayed" }
}
```

The server, in one transaction: creates the space and chats **with the ids
given** (it validates the shape and uniqueness; today `sync/spaces.ts` mints
ids itself, so this is a change), makes the caller admin, creates or finds the
caller's local-agent actor (§12.5), stores the code reference and the pages,
and posts the handoff brief as ordinal 1 of the default chat. It replies:

```json
{ "spaceId": "spc_7Q2M4K",
  "actors": { "me": "act_01M2…", "agent": "act_01M2…" },
  "importedThroughOrd": { "cht_K9XV3N": 0, "cht_P3RT8W": 0 } }
```

**Repeating `begin` with the same `opId` is safe** and returns the same reply —
including how far each chat's import has already got, which is what a retry
after a crash needs.

### 12.5 Who the messages are from

| Local author | On the service |
|---|---|
| `act_local_me` | The publishing person's actor in the target workspace |
| `act_local_agent` | An agent actor **"@harsh's local agent"** with `owner_actor_id` = that person, created on their first publish and reused afterwards. Written with `recordActor`, so every client's directory gets it (the actor-write rule in `SYNC-FLOWS.md`, *Alice sends a message*, §9.1) |

Every imported message carries `origin = 'local_session'` and the local space
id, for provenance. **`delegation_id` stays empty**: no authority was spent on
the service, and a made-up delegation record would corrupt the audit trail the
delegation design exists to protect. And the history is **never** attributed to
the service agent that takes over — it is a different actor that did none of
this work.

### 12.6 `batch` — the history, in order, in pages

```json
POST /rooms/import/batch
{ "opId": "op_PUB01", "spaceId": "spc_7Q2M4K", "chatId": "cht_K9XV3N",
  "messages": [
    { "id": "msg_A1", "ord": 1, "parentId": null, "author": "me",    "body": "Why does sync/catchup.test.ts flake?", "createdAt": 1789000010000 },
    { "id": "msg_A2", "ord": 2, "parentId": null, "author": "agent", "body": "The test races …", "createdAt": 1789000010001,
      "parts": [ … ] },
    …
  ] }
```

- Sent per chat, in `ord` order, in pages of at most 200 messages (the size rule:
  nothing on the wire scales with the company, or here, with the length of the
  session).
- The server assigns real ordinals in a contiguous run **starting after the
  handoff brief**, ignores message ids it already holds (so a retried page is a
  no-op), and replies with the new `importedThroughOrd`, which the client writes
  to `publish_jobs` before sending the next page.
- Thread replies are ordinary rows with `parentId`; the server imports each
  chat's top-level rows before its threads so a parent always exists.
- Tool parts are included, marked collapsed; the review screen's "strip tool
  output" option sends only `body`.

**Import writes history, not live events.** Nobody receives 300 `message.created`
frames. The author's own replica and every invitee get the room the way a
joiner already does: a gap marker, a recent tail, older messages on demand
(`SYNC-FLOWS.md`, *the gap*, §13). Bulk inserts meeting the rule that the
sync frontier never skips a hole is the one place this must be checked against
the catch-up flows before it is built.

### 12.7 `commit`, and after

```json
POST /rooms/import/commit
{ "opId": "op_PUB01", "spaceId": "spc_7Q2M4K", "invite": ["act_01M2…", "act_01M2…"] }
```

The room becomes visible to its members, invitations behave like joins, and the
service agent is told it has a room — sandbox at `base + bundle + patch`, the
brief and the chat tail as its starting context (`AGENT-RUNTIME.md` decides how
it runs from here; §14 lists what that costs).

On the laptop:

```sql
UPDATE local_rooms SET publish_state = 'published', published_at = … WHERE space_id = 'spc_7Q2M4K';
UPDATE publish_jobs SET stage = 'committed', updated_at = … WHERE op_id = 'op_PUB01';
```

- The local room becomes **read-only** and shows a link to the room. Its rows are
  kept: they are the person's record, and the only copy of the parts.
- The screen navigates to `#/w/wsp_01M213…/s/spc_7Q2M4K` with the same query
  string. Open panels and threads carry over because their ids did.
- **No two-way sync.** To keep working locally after publishing, **fork**: a new
  local room whose chats start as forks of the old sessions (§9), clearly a
  separate conversation. Two writers on one conversation drift apart; the
  service side already names that corruption.
- **Code comes back through git** — a room branch, a pull request — never
  through file sync. The laptop's files and the room's sandbox are expected to
  diverge.

### 12.8 When it fails

A retryable failure (offline, 5xx) leaves `publish_state = 'publishing'` and the
job resumes at next opportunity. A definitive one (rejected, no longer a member,
workspace gone) sets `publish_failed`, keeps the job row with `error`, and offers
**Retry** or **Discard**. The room's content is untouched in every case.

### 12.9 Why the service does not resume the Claude session

Anthropic's sessions guide shows a session can be moved to another machine by
copying its `.jsonl` or through a `sessionStore`. Three reasons not to build on
that here:

1. The transcript is full of absolute paths from the laptop.
2. After publish the conversation has several people in it; a Claude transcript
   cannot represent that.
3. It would bind the service's agent to Claude Code and to the person's chosen
   model, when the service runs its own runtime today.

The same guide says capturing results as application state and starting fresh
"is often more robust than shipping transcript files around". The handoff brief
is that, written by the party with the most context and reviewed by a person.

---

## 13. Implementation plan

### 13.1 Spikes first — each can change the design above

| Spike | Question | Changes if it fails |
|---|---|---|
| **SDK in a `utilityProcess`** | Does `@anthropic-ai/claude-agent-sdk` resolve, spawn a child and stream under electron-vite? (`externalizeDepsPlugin` needed care for `@relayed/telemetry`; the failure was runtime-only) | The runner becomes a plain Node child of main instead |
| **Packaged PATH** | Build, launch from Finder, print `PATH`, try to resolve `claude`. Confirm it fails; confirm the explicit resolver fixes it | Nothing — but it must be seen failing once, or the resolver will be "simplified" away |
| **The probe spends nothing** | Run §3.2's probe; confirm nothing new under `~/.claude/projects` and nothing on the usage page | The status screen needs a different source |
| **Delta rate** | Deltas per second on a real turn with `includePartialMessages` | Whether per-frame coalescing suffices or `agent:stream` needs a byte budget |
| **`WebContentsView` overlays** | Does hide-and-snapshot look acceptable when a menu opens over a page? Do bounds keep up with `react-resizable-panels` during a drag? | Page panels ship as "open in a new window" instead |
| **`resumeSessionAt` + `forkSession`** | Do they combine, so a thread can fork from mid-session? | Threads fork from the end of the session (§9.1) |

Each is an afternoon. Each is written as a script under `spikes/`, not as app
code.

### 13.2 Steps — each usable by hand

A step that only ever ran under `node --test` has not been used.

| # | Step | What it proves | Touches |
|---|---|---|---|
| 1 | **Status only.** Settings → Claude Agent: not installed / signed out / ready, with email, plan, version and the **resolved binary path** | The credential story (§3.1), the probe (§3.2), the PATH resolver (§3.6) | new `src/agent-runner/`; a `claude.status` query; a settings pane |
| 2 | **The local store and the room view, with no Claude.** Create a local room, add chats, post messages *by hand*, open panels, threads, anchors, paging | Most of the room view (§11), the shared read contract, `?p=` typed segments | `local-rooms.db` migration; `scope` on queries and ops; `/local/…` routes; `useRoomScope`; the `Chat.tsx` message list pulled into a `RoomView` |
| 3 | **Fixtures for synced-only states** (§11.4), rendered by the same view | The view is not built around local shortcuts | fixture rows; a dev route |
| 4 | **Claude in the room.** Send → child starts → streaming row → tool parts → turn completes | §8 end to end; the runner ↔ sync port; `agent:stream` | runner turn loop; sync-engine event apply; `message_parts`; the stream push |
| 5 | **Approvals, questions, plans, modes.** The four modes; `canUseTool`; the cards. ✅ Built: the mode picker in the room header (new rooms start in `auto`), `approvals` (local-rooms.db v4), `local.rooms.setMode` / `local.approvals.respond`, and the cards at the live edge. Plan is not a room mode yet; an `ExitPlanMode` from the person's own settings still gets its card | §8.5 | `approvals`; ops; cards |
| 6 | **Resume and new chats.** Quit mid-room, reopen, continue; new chat fresh; new chat forked | §3.5, §9 | `chat_sessions`; `startFrom` |
| 7 | **Page panels**, after the overlay spike passes | §10 | main's view manager; the panel registry; `pages` |
| 8 | **Publish, conversation only**, into a new private room. No code, no service agent | §12.1–12.6 with the smallest server change; id preservation; batched import as join-style history; attribution | server: rooms, import endpoints accepting client ids; client: `publish_jobs`, the review screen |
| 9 | **Publish the code and the brief.** Bundle, patch, secret scan, handoff turn | §12.1 steps 2–4 | git helpers in the runner; scan rules; the brief prompt |
| 10 | **The service takes over.** Persistent sandbox, repo access, @-mention starts a run, branch push | The four triggers in §14 | `apps/agent`; a source-control integration |
| 11 | **Fork after publish**; publish *into an existing room* as a new chat | §12.7 | small |

**Step 8 is the milestone to aim at.** It tests the risky idea — a room that
starts on one laptop and becomes a shared one — while the service side stays
almost nothing. Steps 1–7 are all local and need no server change at all.

### 13.3 Observability, proposed

Per `OBSERVABILITY.md` this is a proposal to agree, not a list to add. Service
identity `desktop`; note `agents` is reserved for the service runtime and is
**not** this.

| Signal | The question it answers |
|---|---|
| `claude.probe{outcome}` | Across installs: how many are not-installed / signed-out / ready. The adoption number |
| `claude.turn{outcome}` | completed / failed / interrupted rate. Closed set |
| `claude.turn.duration` | What a local turn costs in wall clock — sets any cap that is ever added |
| `claude.tool{name, ok}` | Which tools are reached for, which fail. **`name` is allowlisted to the built-ins and everything else is `other`** — MCP and skill names are user-authored, and an unbounded label is the cardinality trap the metrics section names |
| `claude.stream.deltas` | Whether `agent:stream` needs a budget |
| `local_room.publish{stage, outcome}` | Where publishes stall |

Two hard lines this feature will argue with more than any other: **no message
body in telemetry** — every interesting debug value here is user content
(prompts, tool input, file paths, command lines) — and **no unbounded id as a
metric label**: `spaceId`, `chatId`, `sessionId` go on spans and structured
events only.

### 13.4 Docs to change in the same commits

| Doc | Change |
|---|---|
| `DESIGN.md`, *agents at the transport layer* (§6.5) and *agents* (§13.8) | A third kind of agent: runs on the laptop, drives local rooms, and is neither a sync participant nor a server-side consumer. The local-agent actor and message provenance |
| `DESIGN.md`, *rooms* (§7.2) | A room can be created from a local session; pages are room objects |
| `STORAGE.md`, *directory layout* (§5) and *sign-out and removal* (§13) | `local-rooms.db` and `local-blobs/` at the account tier, marked "copies the replica's room tables — not a replica"; removal of a *workspace* does not touch them |
| `DESIGN.md`, *the IPC contract* (§13.2) | The `scope: 'local'` exemption from the stale-reply rule, as a new invariant beside 41 |
| `FRONTEND.md`, *the route table* (§4.6) and *panes are query, not path* (§4.7) | `/local/…`; typed `?p=`, which closes the trigger that section names; a rule that no component branches on scope |
| `AGENT-RUNTIME.md`, *deliberately not built* (§8) | The four triggers in §14 below are crossed by step 10 |
| `MULTI-CLIENT-DEV.md` | Two dev clients isolate `userData` and so each has its own `local-rooms.db`, but share one `~/.claude`. Expected, not a bug |

---

## 14. Deliberately not built — and what publishes cross

Local, deferred with a trigger:

| Not built | Adopt when |
|---|---|
| A second Claude config directory / account | Someone has two. Remember the constraint now: a chat cannot move between config dirs, because its session lives in one |
| Skills picker (`$name`) | Wanted. T3 Code's `ClaudeSkillDispatch` documents the CLI rule: only a text block *starting* with `/name` invokes a skill, one per message |
| Attachments in local chats | Wanted. Images go inline as base64 blocks; files as paths the child can read |
| Claude's own file checkpoints / revert | Wanted. A separate subsystem |
| A live agent-run panel kind | The service agent exists and someone wants to watch it |
| Publishing a *page's* browsing state | Never — see §10.3 |

**Step 10 crosses four triggers that `AGENT-RUNTIME.md` lists as reasons to
build something.** They stop being deferred the moment a published room's agent
runs:

| Trigger there | Why rooms cross it |
|---|---|
| **The bash problem**: an end user's text authoring shell commands | Several people writing into one sandbox. A real sandbox, or a smaller tool palette, before launch |
| **Session persistence** and **a per-conversation lock** | One run per room at a time on a workspace that outlives each run |
| **Durable result markers** | Pushing a branch or opening a PR must never happen twice |
| **Per-user credentials / delegation** | Whose repository access, and whose authority when someone @-mentions the agent |

---

## 15. Security, in one paragraph

On the laptop the caller is the machine's owner, driving their own Claude Code,
in a directory they chose — the same trust as typing `claude` in a terminal.
Three things still follow. The agent runner holds no relayed credential (§5).
The directory is chosen explicitly per room and shown in the header. And
**there is exactly one way to start a local turn: a person typing in a local
room.** A message arriving over the sync plane must never start one. The moment
that changes, someone else's text is authoring shell commands on this laptop,
and the containment must change in the same commit. Named now so it is decided
before it is crossed.

---

## 16. Open questions

1. **Subscription approval or API key** (§3.7). Decides nothing in the design,
   everything about whether it can ship.
2. **Streaming in synced rooms.** Local rooms stream because that is what driving
   Claude feels like. `DESIGN.md` rules streaming out for synced agent replies.
   Proposal: `streaming` enters the shared row type now; whether synced rooms
   *show* it is the product decision `AGENT-RUNTIME.md` already says it is.
3. **Display name for `act_local_me`.** "You" is honest but publishes badly in a
   screenshot. Derive from the last-opened workspace's actor row, or ask once.
4. **Where the runner's `PATH` comes from** on Linux and Windows. The resolver in
   §3.6 is written for macOS first.
5. **Retention for `local-blobs/`.** Screenshots pile up. A local room is never
   evicted, but its blobs could be, with a "keep" pin like avatars have.
