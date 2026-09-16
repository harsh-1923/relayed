# Documents, and the room summary

> **Status: proposed.** Nothing here is built. The first kind of document is a
> room's running summary, written by an agent we ship; the table underneath it
> is meant to carry every document kind after that, including human-edited,
> collaboratively-edited ones.

---

## 0. Words used here

| Word | Means |
|---|---|
| **Document** | A body of text that lives in a space and changes over time. Not a message: a message is an event, a document is a thing with a current state. |
| **Room summary** | The document every room has: what is going on in it, maintained for the people in it. Document kind `room_summary`. |
| **Relay** | The app's own agent, provisioned in every workspace. Knows Relayed and helps people use it; owns every other system agent. |
| **System agent** | An agent the app provisions, not a person: no human owner, not editable through the agent routes, its handle reserved. Relay and Roomkeeping are the first two. |
| **Relay Roomkeeping** | The agent we provision in every workspace and add to every room. It writes the room summary. |
| **Refresh** | One pass of the summariser: read what is new, write the next revision. |
| **Watermark** | How far a document's writer had read when it last wrote — per chat, by ordinal. |

---

## 1. What this decides

1. **Documents are their own object**, not a payload on something else, with
   their own table, their own events and their own revisions (§3).
2. **Markdown is canonical now; a CRDT becomes canonical later**, without the
   document, the panel or the sync path changing (§3.4).
3. **A room's summary is written by an agent, as a job, not as a run** — nobody
   invokes it, and it spends nobody's authority (§4.2). It is also written by
   that same agent **when somebody asks it to**, through one tool and one write
   path (§4.8).
4. **What the summariser may read is its own room membership**, not a special
   rule: it is a member of the room, not of the room's private chats (§4.3).
5. **Every room has one, from the moment it exists**, as a structural panel
   nobody has to open (§4.1, §8).
6. **A refresh is triggered by message count, not by a clock** (§4.4).
7. **The summary cites the messages it is derived from**, and clicking a
   citation goes to that message and highlights it (§5).
8. **Humans cannot write a room summary directly.** Not hidden in the UI —
   refused at the write path, which is the only place a document is written.
   Asking Roomkeeping to change it is how a person changes it (§4.8, §6).
9. **A system agent is owned by another agent, not by a person.** Relay owns
   Roomkeeping; Relay is owned by nobody. Ownership there is provenance, and
   deliberately **not** an edit grant (§9).

---

## 2. The idea in one picture

```
   a room                                  the room's summary panel
   ┌───────────────────────────┐           ┌────────────────────────────────┐
   │ #default chat             │           │ Summary          Updated 4m ago │
   │  Alice: the migration is  │           │ covers up to 14:32              │
   │         blocked on …      │  ───────▶ │                                 │
   │  Bob:   I'll take the     │  15 new   │ **Now.** The migration is       │
   │         rollback plan     │ messages  │ blocked on the index rebuild…   │
   │  @triage: filed LIN-42    │  trigger  │                                 │
   │                           │ a refresh │ **Decided.** Roll back first,   │
   │ #db-cutover (public)      │           │ then retry — [Alice](message:…) │
   │  …                        │           │                                 │
   │                           │           │ **Open.** Who owns the retry?   │
   │ #incident (private)  ✗    │           │                                 │
   │  never read by the        │           │ **Who's on what.** Bob: rollback │
   │  summariser               │           └────────────────────────────────┘
   └───────────────────────────┘             written by @relay-roomkeeping
```

The private chat is not excluded by a rule in the summariser. It is excluded
because the agent is not a member of it, and the access predicate is the same
one that governs every other reader (`DESIGN.md` §7.3).

---

## 3. The document as an object

### 3.1 One table, discriminated by kind

The same shape `spaces` and `panels` already use. A document is "text with a
current state that belongs to a space"; only policy differs by kind — who may
write it, whether it is derived from something else, whether it is structural.

| `kind` | Belongs to | Written by | Built |
|---|---|---|---|
| `room_summary` | a room | Relay Roomkeeping, as a job | this document |
| `note` | any space | people, collaboratively | later — reserved in the CHECK now |

`note` is reserved in the CHECK for the reason `panels` reserved `diff`, `file`
and `attachment`: on SQLite a CHECK cannot be altered, and the replica pays for
a rebuild it can avoid for free today (`workspace.ts` version 6 is the
cautionary example).

### 3.2 Schema — server

```sql
CREATE TABLE documents (
  id                  TEXT PRIMARY KEY,              -- doc_…, a ULID
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id            TEXT NOT NULL REFERENCES spaces(id)     ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  title               TEXT,

  -- The document itself. Markdown until a CRDT takes over (§3.4); `format`
  -- exists so that swap is a value, not a schema change.
  body                TEXT NOT NULL DEFAULT '',
  format              TEXT NOT NULL DEFAULT 'markdown',

  -- Monotonic per document. Every write increments it; every reader keeps the
  -- highest it has seen, so an event arriving late cannot wind a client back.
  rev                 INTEGER NOT NULL DEFAULT 0,

  -- Who wrote the current revision. An actor, always — the Roomkeeping agent
  -- for a summary, a person for a note. Never NULL in practice; nullable
  -- because an actor may be deleted and the document outlives them.
  updated_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,

  -- How far its writer had read: { "cht_…": 412, "cht_…": 88 }. Per chat,
  -- by ordinal, because ordinals are per chat and a wall clock across chats
  -- would skew. NULL for a document not derived from messages.
  covered_through     JSONB,

  -- The refresh lease, the same shape `agent_runs` uses: a job claims a
  -- document by setting this, and a lease in the past means the server that
  -- claimed it is gone, not that a refresh is still running.
  refresh_lease_until TIMESTAMPTZ,
  refresh_failures    INTEGER NOT NULL DEFAULT 0,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT document_kind   CHECK (kind IN ('room_summary', 'note')),
  CONSTRAINT document_format CHECK (format IN ('markdown')),
  CONSTRAINT document_rev    CHECK (rev >= 0)
);

-- A room has exactly one summary. The index is what makes that true, rather
-- than every writer remembering to check first.
CREATE UNIQUE INDEX document_room_summary ON documents(space_id) WHERE kind = 'room_summary';
CREATE INDEX document_space ON documents(space_id);
```

### 3.3 Revisions

```sql
CREATE TABLE document_revisions (
  document_id     TEXT    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  rev             INTEGER NOT NULL,
  body            TEXT    NOT NULL,
  author_actor_id TEXT    REFERENCES actors(id) ON DELETE SET NULL,
  covered_through JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, rev)
);
```

Full snapshots, not diffs: a summary is kilobytes, and a diff format is a second
thing to keep true for no gain at this size. **Retention: the last 50 revisions
per document**, pruned in the same transaction that writes a new one.

Why keep them at all, when only the current body is ever rendered:

- **A bad summary is recoverable** without waiting for the next refresh.
- **"What changed since I last looked"** is the obvious next feature, and it
  needs two bodies. Building the table later means writing history we never
  kept.
- **It is the audit trail** for the one object in the app written by a machine
  on nobody's behalf.

### 3.4 What is canonical, and the CRDT migration

Today there is **exactly one writer** per room summary — a job that refreshes
under a lease. So the current body plus a monotonic `rev` is sufficient: no
concurrent edits, therefore no merge, therefore no CRDT.

That is not true of `note`, and the point of this table is to reach it without a
rewrite. When collaborative editing arrives:

1. A `document_updates` table is added — `(document_id, seq, update BYTEA,
   actor_id, created_at)` — carrying opaque CRDT updates (Yjs), which merge in
   any order and therefore need nothing from the ordering guarantees of the
   event log.
2. `documents.format` becomes `'crdt'` for those documents. **`body` stays**, as
   the derived markdown snapshot: search, an older client, and the summariser's
   own prompt all want text, not a binary blob.
3. The document's identity, its panel, its events, its access rule and its place
   in `welcome` do not change.

The editor makes the same move: **Tiptap, read-only, from day one** — not the
plain markdown renderer — because Tiptap plus Yjs is the collaborative path, and
starting on the renderer we would have to throw away is the expensive shortcut.

### 3.5 Schema — replica

```sql
CREATE TABLE documents (
  id                  TEXT PRIMARY KEY,
  space_id            TEXT NOT NULL,
  kind                TEXT NOT NULL,
  title               TEXT,
  body                TEXT NOT NULL DEFAULT '',
  format              TEXT NOT NULL DEFAULT 'markdown',
  rev                 INTEGER NOT NULL DEFAULT 0,
  updated_by_actor_id TEXT,
  covered_through     TEXT,              -- JSON, for the "covers up to" line
  updated_at          INTEGER NOT NULL
);
CREATE INDEX document_space ON documents(space_id);
```

**No CHECK on `kind` or `format`**, deliberately, and the same rule panels
already hold: a kind this build does not know is **kept and drawn as a
placeholder**, never dropped. A newer client wrote it.

---

## 4. The room summary

### 4.1 Every room has one

Created in the same transaction as the room itself (`createRoom`), alongside its
default chat and its founding membership — plus:

- the `documents` row (`kind = 'room_summary'`, empty body, `rev = 0`),
- a `panels` row of the new type `doc` (§8) pointing at it,
- the Roomkeeping agent's space membership.

All of it or none of it. A room whose summary panel exists but whose document
does not is a tab that renders an error, and the transaction is what stops that
being a state anyone can reach.

**Existing rooms** get theirs from a one-off backfill, which is the same three
writes per room and is idempotent.

An empty summary (`rev = 0`) renders as "Nothing yet — this fills in as people
talk", not as an empty panel.

### 4.2 Who writes it: a job, as the Roomkeeping agent

**Not an agent run.** Every run needs an invoker whose authority it spends
(`WORKSPACE-AGENTS.md` §5.5): permissions, connections, access cards. A refresh
has no invoker — nobody asked for it — and inventing a fake one would put a
person's name on something they did not ask for, and their connections behind
something they cannot see.

So it is a **job**, in the shape the catalogue refresh already uses
(`catalogue.ts`): a loop that claims work, does it, and writes the result.

| | An agent run | A summary refresh |
|---|---|---|
| Started by | a mention | message count crossing a threshold |
| Acts for | the person who mentioned it | nobody |
| May reach | that person's connected accounts | nothing outside the room |
| Tools | `find_tools`, `call_tool`, the app tools | **none** (`RunRequest.grant` is already optional for a toolless run) |
| Writes | a reply message | a document revision |
| Costs | the deployment's model budget | the deployment's model budget |

It still **acts as an actor**: `updated_by_actor_id` is the Roomkeeping agent,
so the panel can say who wrote it and the audit trail names something real.

**Two writers, one write path.** The job is not the only way a revision is
written — asking Roomkeeping writes one too (§4.8). Both go through the same
function, which bumps `rev`, appends the revision, prunes, and emits the event.
They cannot interleave badly: the job holds the lease while it works, and a
mention that lands mid-refresh writes the next revision after it, never over it.

**Why an agent actor rather than "the system":** because the privacy rule then
needs no special case. The agent is a member of the room; the access predicate
decides what it may read, exactly as it does for a person (§4.3). A system
writer with no actor would need a second, parallel answer to "what may this
read", and two answers to that question is how leaks happen.

### 4.3 What it may read

The transcript the summariser builds is filtered by **the Roomkeeping agent's
own read access**, with the same predicate `transcript.ts` already uses:

- **The room's `default` and `public` chats.** It is a member of the space.
- **Not private chats.** Those need a `chat`-scoped membership it does not have.
  Nobody grants it one; if somebody adds it to a private chat, that chat becomes
  fair game — which is the correct behaviour, and is a decision that member made
  knowingly.
- **Not a restricted message** (`visible_to` non-null) unless the agent is
  listed on it, which it will not be.
- **Nothing outside Relayed.** No tools means no ticket bodies, no pages, no
  third-party content that somebody in the room cannot already see.

### 4.4 When it refreshes

**By message count, not by a clock.** A room with a burst of forty messages
needs a refresh; a room with one message an hour does not need six.

| Rule | Value | Why |
|---|---|---|
| Threshold | **15** new readable messages since `covered_through` | Enough that a refresh has something to say; small enough that the panel is not stale through a working session |
| Floor | never twice within **60 s** for one room | A burst crossing the threshold twice in a second is one refresh |
| Lease | **2 min**, `refresh_lease_until` | Two servers never summarise one room twice; a dead server's claim expires |
| Backoff | `refresh_failures`, doubling up to 30 min | A room whose refresh keeps failing stops burning budget |

**Only `active` rooms refresh.** A dormant or archived room keeps its summary —
the panel, the document and every revision stay exactly as they are, readable
offline like the rest of the room's content — and the job skips it. A room that
wakes up refreshes when it next crosses the threshold, which is the same rule as
any other room rather than a special case for waking.

The threshold is an env value, so a deployment can retune it without a release.
The loop picks work by comparing each room's chats' `next_ord` against its
summary's `covered_through` — no queue table, because the two numbers the
decision needs are already stored, and a queue would be a third copy of the same
fact.

### 4.5 Incremental, with a periodic rebuild

Each refresh is given **the previous summary plus the messages since the
watermark**, and asked for the next summary. That is what makes a running
summary cheap.

The failure mode is drift: a summary of a summary of a summary keeps its
mistakes and loses its specifics. So **every 20th revision is a rebuild** — the
previous body is not given, and the window is the last ~400 readable messages
instead of the delta. Cheap insurance, and it is why `rev` is on the row.

Budgets: the new-message window is capped at the same **24 KB** the agent
transcript uses (`transcript.ts`), oldest dropped first; the summary body itself
is capped at **8 KB**, which keeps both the panel and the next prompt bounded.

### 4.6 What it says

Free-form Markdown. The prompt suggests a shape rather than imposing one, so a
room with nothing decided yet does not render four empty headings:

- **Now** — the current state, in a sentence or two.
- **Decided** — decisions and who made them, each citing its message.
- **Open** — questions nobody has answered, blockers, what is waiting on whom.
- **Who's on what** — names against work.
- **Links** — tickets, dashboards, documents named in the conversation.

The prompt's standing rules: **describe the state, do not narrate the
transcript**; **cite a message for anything specific** (§5); **say nothing you
cannot support**; **prefer dropping a section to padding it**.

### 4.7 When a refresh fails

The previous body stays. A failed refresh never blanks the panel and never
advances `covered_through` — the same messages are read again next time.
`refresh_failures` drives the backoff and is reset by a success. The header
keeps saying how far the summary actually covers, which is the honest answer
while refreshes are failing.

### 4.8 Asking Roomkeeping directly

> "@roomkeeping look at ticket-20349 and add the details to the room summary."

That is an **ordinary agent run** — a mention, a person, that person's
authority — with one addition: a run by Roomkeeping in a room is offered an app
tool the other agents are not.

```
write_room_summary({ body })   — replaces this room's summary with `body`
```

- **Offered only to Roomkeeping, only in a room.** The first tool that depends
  on which agent is running, which is the per-agent tool policy arriving as one
  `if` rather than as a framework.
- **The current summary is in its system prompt** for such a run, so "add the
  details" means editing what is there rather than writing a new document from
  nothing. It is at most 8 KB.
- **The same write path as the job** (§4.2): `rev`, revision, prune, event.
  `updated_by_actor_id` stays the agent; the person is recorded the way every
  agent write records one, through the run.
- **The watermark does not move.** A person's request is not a pass over the
  messages, so the next scheduled refresh still covers what it would have.
- **It spends the person's authority for everything else.** Reading ticket-20349
  is `find_tools` + `call_tool` against *their* Linear connection, with the
  ordinary access card if they have not connected it. Roomkeeping has no
  connections of its own, and this tool grants none.

This is also the answer to "the summary is wrong": tell Roomkeeping. Before this
tool, the only remedy was to say it in the room and hope the next refresh
noticed.

---

## 5. Message references

### 5.1 The link form

`[what it says](message:msg_…)` — the same family as the actor mentions
(`actor:act_…`) and room links (`space:spc_…`) the renderer already knows. An
app link, not a web address: it means nothing outside Relayed, and the renderer
decides what it does.

This is what makes the summary checkable instead of merely plausible. A claim
with a citation can be verified in two clicks; a claim without one is the
model's word.

### 5.2 Jumping, and the honest problem

Clicking a citation: go to the chat, scroll to the message, highlight it for a
moment.

**The part that is not free, and is deferred on purpose.** A chat's replica read
is the **last 200 messages** (`storage.messages`), with no way to ask for a
window around a particular message. A citation older than that has nothing to
scroll to. Three pieces, and only the first two are in this build:

1. **Render and route** the link: resolve the message to its chat and space
   locally, and navigate there. *In this build.*
2. **Scroll and highlight** when the message is in the loaded window. *In this
   build.*
3. **Load around a message** when it is not: a replica read anchored on a
   message id, falling back to a server backfill when the replica does not hold
   it. **Deferred, as its own task.** It is wanted by search, by threads and by
   every future citation, so it should be built properly for all of them rather
   than half-built here for one.

Until 3 exists, a citation the window does not contain still navigates to the
chat — it lands you in the right conversation and says the message is further
back, rather than doing nothing.

---

## 6. Access, in one expression

Reading a document is reading its space:

```
read(document) ⟺ read(document.space)
```

Nothing new: the space predicate (`DESIGN.md` §7.3) already answers it, and a
room summary is therefore visible to exactly the room's members, on every
device, offline.

Writing:

```
write(document) ⟺ kind = 'room_summary' ∧ writer = the room's Roomkeeping agent
```

There is no op, no route and no IPC by which a person writes one. The panel has
no edit affordance, but that is not the guard — **the guard is that the only
writer is the summariser**, and it is the same rule whether a request arrives
from a person, an agent, or a bug.

---

## 7. Sync

### 7.1 Events

One event type, on the **space stream** — a room summary is the room's, not any
one chat's, and every room member is entitled to it.

```jsonc
// document.updated — the COMPLETE row, so a client that missed an earlier one
// is corrected by this one rather than left holding a hole.
{
  "id": "doc_01M2…", "space_id": "spc_01M2…", "kind": "room_summary",
  "title": null, "body": "**Now.** …", "format": "markdown", "rev": 7,
  "updated_by_actor_id": "act_01M2…", "covered_through": { "cht_01M2…": 412 },
  "updated_at": "2026-09-16T14:32:11.882Z"
}
```

Creation is `rev = 1`; there is no separate `document.created`. A second event
type would mean every recipient handling two shapes of the same fact.

### 7.2 Apply

Upsert by id, and **never move `rev` backwards** — the same discipline
`panel.opened` holds for `opened_at`. An event that arrives out of order, or
twice, converges on the highest revision.

### 7.3 Welcome and hydration

- `welcome` carries the documents of every room the actor has joined, beside its
  panels.
- The join hydration (`space.member_added`) carries the room's documents, so
  **somebody added to a room has the summary before they have read a single
  message.** That is the arriving case from §2, and it is the reason the feature
  exists.

---

## 8. Rendering

### 8.1 A new panel type: `doc`

| `type` | `chat_id` | `payload` |
|---|---|---|
| `doc` | — | `{ "document_id": "doc_…" }` |

Added to the `panels` CHECK on the server; the replica has no type CHECK by
design, so it needs none.

**Structural, like a room's default chat.** It is created with the room, it is
always in the tab strip, and `local.panels.remove` refuses it the way it already
refuses a chat panel. Nobody has to know to open it, and nobody can lose it.

### 8.2 The panel

- **Tiptap, read-only** (§3.4), rendering the markdown, with the app's mention
  and link handling — including the message citations, which are clickable.
- A header that is honest about staleness: **who wrote it**, **when**, and
  **how far it covers** ("covers up to 14:32"), from `covered_through`.
- **Refresh now**, which asks the server to drop the threshold for this room
  once. Rate-limited, and disabled while a refresh holds the lease.
- An empty document says what it is waiting for, not nothing.
- No edit affordance, no cursor, no toolbar. The way to correct it is to tell
  Roomkeeping (§4.8) — "@roomkeeping the second paragraph is wrong, we rolled
  back" — which is both the correction and a record of who made it.

---

## 9. The Relay agents

Two actors, provisioned per workspace, never by a person:

| Agent | Handle | Owned by | Member of | Purpose |
|---|---|---|---|---|
| **Relay** | `@relay` | nobody | nothing by default | The app's own agent: knows Relayed, helps people use it, and is who you ask about the others. |
| **Relay Roomkeeping** | `@roomkeeping` | **Relay** | **every room**, from creation | Writes the room summary (§4.2), and edits it when asked (§4.8). |

Both are ordinary `actors` rows of type `agent` with `agents` definitions, which
is what makes them addressable, mentionable and visible in the directory like
anything else.

### 9.1 System agents, and why Relay owns the others

`actors.owner_actor_id` today means "the person who operates this agent", and it
is required for every agent. Neither of these has one — and the answer is not to
make the column nullable for a growing class of agents, because a column that is
null everywhere it matters has stopped meaning anything.

Instead: **a system agent is owned by another system agent, and Relay is the
root.**

- **Relay's owner is NULL.** Exactly one row in a workspace, and the relaxed
  CHECK exists for it alone.
- **Roomkeeping's owner is Relay**, and so is every system agent we add after
  it. "Who operates this?" keeps a real answer, and it is one you can @mention.
- **`provisioned_by = 'system'`** is added to its CHECK, which is what the
  relaxed owner rule keys off: only a system-provisioned agent may lack an
  owner.

Two migrations, both small:

```sql
ALTER TABLE actors DROP CONSTRAINT actor_prov;
ALTER TABLE actors ADD  CONSTRAINT actor_prov
  CHECK (provisioned_by IN ('self_signup','invite','sso_jit','scim','api','system'));

ALTER TABLE actors DROP CONSTRAINT actor_owner;
ALTER TABLE actors ADD  CONSTRAINT actor_owner CHECK (
  CASE WHEN type = 'agent' THEN owner_actor_id IS NOT NULL OR provisioned_by = 'system'
                           ELSE owner_actor_id IS NULL END);
```

**Relay does not literally create Roomkeeping.** The server writes both rows in
`seedWorkspace`; the ownership is recorded provenance, not a run that happened.
Building a real "Relay provisions agents" path would be theatre today — though
it is the natural shape if Relay ever gains tools that create things.

### 9.2 Ownership here is provenance, not permission — the trap

Today, **owner is an edit grant**: the owner and the maintainers are who may
change an agent's instructions (`WORKSPACE-AGENTS.md` §4.4). If that flowed
through Relay, then any member could edit Roomkeeping by asking Relay to do it —
a run acts for a person, and Relay's half of the intersection would pass. The
rule that system agents are ours would last exactly as long as nobody thought of
that sentence.

So it is stated as its own rule, enforced in the agent routes rather than
implied by ownership:

> **A system agent cannot be edited, deactivated, or have its maintainers
> changed, by anyone — person or agent — whatever `owner_actor_id` says.**

Ownership answers "where did this come from" and "who do I ask about it". It
grants nothing. When a system agent's instructions change, they change the way
the rest of the app changes: in a release.

### 9.3 Consequences, stated so they are decisions

- **Mentioning `@roomkeeping` starts an ordinary run**, with the full tool set
  every run gets, plus `write_room_summary` (§4.8). Asking it to read a ticket
  and fold the details into the summary works, and spends the asker's Linear
  access, not the agent's.
- **Mentioning `@relay` starts an ordinary run too.** For now its instructions
  describe Relayed and how to work in it. Teaching it the app properly — the
  docs, the current workspace's shape, what a person is actually looking at — is
  its own piece of work, and this document does not attempt it.
- **`relay` and `roomkeeping` are reserved handles**, enforced by the existing
  unique handle index the moment the actors exist.
- **Deactivating Roomkeeping is not a way to turn summaries off.** The
  per-workspace switch is (§10); the agent staying active is what keeps the
  existing summaries readable and attributed.

---

## 10. Security

| Threat | What stops it |
|---|---|
| The summary discloses a private chat | The summariser is not a member of one; the access predicate is the only reader rule (§4.3) |
| The summary discloses a restricted message | Same predicate: `visible_to` excludes it |
| Text in the room steers the summariser into doing something | It has **no tools** and no grant. The worst an injection achieves is a wrong summary, which the next refresh replaces and the citations expose |
| A person edits the summary to say something false in the app's voice | There is no write path for a person (§6) |
| The summary quietly goes stale and is trusted | The header always says how far it covers; a failed refresh never advances the watermark (§4.7) |
| A room burns model budget | Threshold, floor, lease and backoff (§4.4); a per-workspace off switch |
| Two servers summarise one room at once | The lease, claimed with a conditional update (§4.4) |

---

## 11. Deliberately not built

| Not built | Trigger to build it |
|---|---|
| **Human-edited and collaboratively-edited documents** | The first `note`. The table, the panel and the sync path are already shaped for it (§3.4) |
| **"What changed since I last looked"** | Someone asks. `document_revisions` is what it needs and it is being kept from the start |
| **Unread/attention on the summary tab** | Deferred by decision: a summary that pings you is not restful. A dot, when it comes, is a per-person read marker |
| **Summaries for channels and DMs** | A channel that behaves like a room. The kind is not room-specific; the job is |
| **Summaries in local rooms** | The summariser is a server job and a local room has no server. Its own Claude Code could do it, which is a different build (`LOCAL-ROOMS.md`) |
| **A per-room prompt or focus** | A room wants "track decisions only". One column, once somebody wants it |
| **Diff-based revisions** | The body stops being kilobytes |
| **Jumping to a message outside the loaded window** | Deferred by decision (§5.2), and worth building once, properly, for search and threads as well as citations: an anchored replica read plus a server backfill around a message id |

---

## 12. Implementation plan

Each step is usable by hand before the next one starts.

### Step 1 — Documents exist, and a room has one

- Server migration: `documents`, `document_revisions`, `'doc'` in the panel CHECK.
- `createRoom` also writes the summary document and its structural panel, in the
  same transaction. Backfill for existing rooms.
- `document.updated` event, `welcome` and hydration carry documents.
- Replica migration, apply, storage read, `documents.list` / `document.get`.
- **Usable by hand:** a document written with SQL appears in every member's
  panel, on every device, offline, and a new member gets it on join.

### Step 2 — The panel

- Tiptap read-only renderer, the header (who, when, covers-up-to), the empty
  state, and the Refresh button (disabled until step 4 gives it something to do).
- **Usable by hand:** the same SQL-written document is legible, attributed and
  honest about its horizon.

### Step 3 — The Relay agents

- Migrations for `provisioned_by = 'system'` and the relaxed owner CHECK (§9.1).
- Provision `@relay` (owner NULL) and `@roomkeeping` (owner Relay) per
  workspace, idempotently, in `seedWorkspace` plus a backfill for existing
  workspaces.
- Roomkeeping joins every room at creation, and every existing room once.
- Agent routes refuse edit, deactivate and maintainer changes on a system
  agent — for every caller, including a run acting for a person (§9.2).
- **Usable by hand:** both agents are in the directory, `@roomkeeping` is in
  every room, mentioning either answers, and neither can be edited by anyone.

### Step 4 — The summariser job

- The write path first — bump `rev`, append the revision, prune to 50, emit the
  event — because both writers use it (§4.2).
- The loop: claim by lease, build the transcript with the agent's own access,
  call the runtime with no tools, write.
- Threshold, floor, backoff, active-rooms-only, the periodic rebuild, the body
  cap.
- Telemetry: refreshes, failures, tokens, staleness.
- `Refresh now` drops the threshold once, rate-limited.
- **Usable by hand:** talk in a room, cross the threshold, watch the panel fill
  in — and check that a private chat in the same room never appears in it.

### Step 5 — Asking Roomkeeping

- `write_room_summary`, offered only to Roomkeeping and only in a room, through
  the step 4 write path (§4.8).
- The current summary in the system prompt of a Roomkeeping run.
- **Usable by hand:** "@roomkeeping look at LIN-42 and add it to the summary"
  reads the ticket with your Linear access and edits the panel; "@roomkeeping
  the second paragraph is wrong, we rolled back" fixes it.

### Step 6 — Message citations

- The `message:msg_…` link form, rendered and routed to the chat.
- Scroll and highlight within the loaded window; a citation outside it lands in
  the chat and says the message is further back.
- The prompt starts asking for citations once this renders — before it, a raw
  `message:` link in the panel would be noise.
- **Deferred to its own task, not this build:** the anchored read plus server
  backfill (§5.2, §11).

### Step 7 — Docs

`PANELS.md` (the `doc` type, the structural panel), `DESIGN.md` (documents
beside spaces and chats), `WORKSPACE-AGENTS.md` (jobs that are not runs, the
Relay agents), `SYNC-FLOWS.md` (the new event), and this document's status.

---

## 13. Tests that must exist

| Test | Proves |
|---|---|
| A room's creation writes the document, the panel and the membership, or none of them | §4.1 atomicity |
| The summary panel cannot be removed | §8.1 |
| A revision write bumps `rev`, appends a revision, prunes past 50, and emits the complete row | §3.3, §7.1 |
| An event with a lower `rev` never overwrites a higher one | §7.2 |
| `welcome` and join hydration carry the room's documents | §7.3 |
| The summariser's transcript contains default and public chats, and **never** a private chat or a restricted message | §4.3 — the one that matters most |
| A refresh below the threshold does not run; crossing it runs exactly once | §4.4 |
| Two claimants, one refresh | §4.4 lease |
| A failed refresh keeps the old body and does not advance the watermark | §4.7 |
| Every 20th revision is a rebuild | §4.5 |
| No write path accepts a document write from a person | §6 |
| A dormant or archived room keeps its summary and is never refreshed | §4.4 |
| `write_room_summary` is offered to Roomkeeping in a room, and to no other agent anywhere | §4.8 |
| A summary written through the tool bumps `rev` and does **not** move the watermark | §4.8 |
| A system agent cannot be edited, deactivated, or have maintainers changed — by a member **or** by a run acting for one | §9.2 |
| Relay has no owner; Roomkeeping's owner is Relay; both are `provisioned_by = 'system'` | §9.1 |
| Provisioning twice makes one pair of agents, not two | §9 |
| `message:` links parse, route, and highlight; an unloaded one says so | §5 |

---

## 14. Open questions

Answered, and kept here because the reasons matter later:

| Question | Answer |
|---|---|
| Is `@relay` in this build? | **Yes.** It is a system agent like Roomkeeping, useful on its own, and provisioning both at once is one migration and one seeding path rather than two. Teaching it the app deeply is separate work (§9.3). |
| Are the summariser's own runs tool-less? | **Yes** — the job has no tools and no grant. A *mention* is an ordinary run and keeps everything (§4.2, §9.3). |
| Threshold of 15 | **Kept**, and env-tunable. The telemetry in step 4 is what replaces the guess (§4.4). |
| Where the summary sits in the tab strip | **First.** It is what you should see on arriving (§8.1). |
| A dormant or archived room | **Everything stays, nothing refreshes** (§4.4). |

Still open:

1. **What `@relay` actually knows.** "Knows the app" is doing a lot of work in
   §9. Its instructions can describe Relayed; knowing *this* workspace — what
   rooms exist, what the person is looking at, what they just tried — is a
   design of its own, and probably the next one after this.
2. **Whether `note` is the right second kind.** It is reserved, not designed. A
   collaboratively-edited note is the obvious next document, but a room's
   decision log or a runbook might earn the CRDT first.
3. **How a summary reads when a room is huge.** The 8 KB cap is a guess about
   where "summary" stops being one. A room running for months may want the
   summary plus an archive of past summaries, which `document_revisions` already
   holds.
