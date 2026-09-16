# Panels

> **Status: a proposal, partly built.** Panels in **local rooms** are built: the
> tables, side chats, local web panels, sharing into the room, and the panel
> container with tabs, and web pages drawn inside them as `<webview>` (§12.2
> says exactly what). Nothing synced is built — the server writes no rooms yet. It
> replaces the *page* object in [`LOCAL-ROOMS.md`](LOCAL-ROOMS.md) §10 and extends
> the room model in [`DESIGN.md`](DESIGN.md) §7. §13 lists the edits the other
> documents need; where one has not landed, that document wins.

**Last updated:** 2026-09-14

---

## 0. Words used here

| Word | Meaning here |
|---|---|
| **Room** | A space with `kind='room'`: one default chat plus any number of public and private chats (`DESIGN.md` §7.1–§7.2). |
| **Main pane** | What the route addresses: the space's `sole` or `default` chat. The route never names any other chat. |
| **Panel** | A surface in a room that opens beside the main pane. It has a **type**: `chat`, `web`, `diff`, `file`, `attachment`, and more later. |
| **Panel container** | The right-hand side of a split room: a row of tabs, and the one panel shown beneath them. |
| **Tab** | A panel that is open in the container. Several may be open; one is shown. |
| **Chat panel** | A panel whose content is one of the room's non-default chats. |
| **Content panel** | Every panel that is not a chat panel: a web page, a diff, a file, an attachment. |
| **Local panel** | A panel that exists only on this device. Nobody else knows it exists, including the server. |
| **Shared panel** | A panel synced to the room. Everyone entitled to it receives it. |
| **Share** | Turning a local panel into a shared one. One-way. |
| **Open / closed** | Whether the container is visible and whether a panel is one of *your* tabs right now. View state, carried in the URL, never stored. |
| **Removed** | Whether a panel still exists in the room. Shared state, stored. |

---

## 1. What this doc decides

| Question | Decision | § |
|---|---|---|
| What is a panel? | A **room object with a type**, in one table discriminated by `type` — the same shape as `spaces` by `kind`. | 3 |
| Which panel types first? | `chat` and `web`. `diff`, `file`, `attachment` are reserved in the type list and built later. | 3.3 |
| Where do non-default chats appear? | **Always in a chat panel.** Every non-default chat has exactly one, created with the chat. The default chat never has one. | 4 |
| Who can see a chat panel? | **Whoever can see the chat.** Visibility is not stored on the panel; it is the chat's. A private chat is a private panel automatically. | 4.2 |
| Who can see a content panel? | **Local:** only you, on this device. **Shared:** everyone in the room. | 5 |
| Is there a "synced but private to me" panel? | **No.** Not until someone needs it on a second device. It is the one case that needs a new sync stream (§11). | 5.3 |
| Do content panels sync by default? | **No. Local until shared.** Most are a quick look — a URL, a diff — and are gone in minutes. | 5 |
| Do chat panels sync? | **Always.** The chat does, so its panel does. Private chat panels included. | 4 |
| Which stream carries panel events? | Chat panels → **the chat's stream**. Shared content panels → **the space stream**. No new stream kind. | 7 |
| Can a shared panel be un-shared? | **No.** Once seen, seen (`DESIGN.md` §7.4). It can be removed. | 5.4 |
| How many panels show at once? | **One.** Open panels are tabs in one container on the right; opening another adds a tab rather than splitting again. The container may also be open with no tabs so it can offer the first panel choices. | 10 |
| What does the URL carry? | **The space in the path, panels in the query**: `?p=` the open tabs as panel ids, `?pa=` the one shown. A bare chat id still resolves to that chat's panel. | 8 |
| What happens when an agent opens a URL? | It writes a **panel part** into its message. Clients turn it into a local panel for the person the agent acted for; everyone else sees a link. | 9 |
| How is a web page rendered? | A **`<webview>` in the panel's DOM**, kept mounted while its tab is open, every attach checked by main. Not `WebContentsView`, which `LOCAL-ROOMS.md` §10.1 first chose: it draws over menus and dialogs. | 10.3 |

---

## 2. The idea in one picture

```
  no tabs open                          tabs open: the pane splits, and is resizable
  ┌──────────────────────────────────┐  ┌──────────────────────┬─────────────────────────────┐
  │ space header                     │  │ space header         │ [try fix B] [localhost]     │
  ├──────────────────────────────────┤  ├──────────────────────┼─────────────────────────────┤
  │                                  │  │                      │                             │
  │ default chat                     │  │ default chat         │ the shown tab               │
  │ (never a panel)                  │  │                      │                             │
  │                                  │  │                      │ chat "try fix B": private,  │
  │                                  │  │                      │ SYNCED, only its members    │
  │ composer                         │  │ composer             │ see it                      │
  └──────────────────────────────────┘  └──────────────────────┴─────────────────────────────┘
                                         the other tab, localhost:5173, is LOCAL: only on this
                                         laptop, nobody else knows it exists, until it is shared

                          where does it live?
                     this device        synced
                   ┌───────────────┬─────────────────────────────┐
   who sees it?    │               │                             │
     only me       │ local content │   (not built — §5.3)        │
                   │ panel         │                             │
                   ├───────────────┼─────────────────────────────┤
     chat members  │      —        │ chat panel, private chat    │
                   ├───────────────┼─────────────────────────────┤
     the room      │      —        │ chat panel, public chat     │
                   │               │ shared content panel        │
                   └───────────────┴─────────────────────────────┘
```

The point of the grid: **"private" was two questions**. *Where does it live* and
*who can see it* are separate axes, and only three of the six cells are needed.
The empty-but-plausible cell — synced, visible only to me — is the one that
would have needed new sync machinery, and nobody has asked for it.

---

## 3. The panel as a room object

### 3.1 One table, discriminated by type

The same argument `DESIGN.md` §7.1 made for spaces applies unchanged: every
panel is *"a surface in a room with a creator and a lifetime"*, and only what it
shows varies. One table with a `type` column gives:

- one access expression rather than one per type (§6);
- one event pair (`panel.created`, `panel.removed`) rather than one per type;
- one URL shape and one renderer registry;
- a new type as a new `CHECK` value and a new renderer component — no new table,
  no new event, no new stream.

The alternative, a table per type (`web_panels`, `diff_panels`, …), was an
earlier draft of this proposal. It reproduces the three-parent-tables mistake
§7.1 already rejected: `?p=` would need to know which table an id belongs to, and
every "list the room's panels" query would be a `UNION`.

### 3.2 Schema — synced panels

Server (`apps/server/src/db/migrations/009_panels.sql`):

```sql
CREATE TABLE panels (
  -- CLIENT-generated ULID, prefixed pnl_. A local panel gets its id when it is
  -- opened, and KEEPS it when shared (§5.2) — which is what keeps a ?p= link
  -- pointing at the same thing across the share.
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id            TEXT NOT NULL REFERENCES spaces(id)     ON DELETE CASCADE,
  type                TEXT NOT NULL,

  -- A chat panel's content. A real foreign key, because a chat panel with no
  -- chat has no meaning and must go when the chat goes.
  chat_id             TEXT REFERENCES chats(id) ON DELETE CASCADE,

  -- Everything else a type needs, as JSON (§3.3). Promoted to a column the
  -- moment a type needs referential integrity, as chat_id was.
  payload             JSONB NOT NULL DEFAULT '{}',
  title               TEXT,

  -- Where it came from: the chat it was opened from, and by whom. Neither
  -- grants anything; both are for rendering ("opened by @claude in #fix-b").
  opened_from_chat_id TEXT REFERENCES chats(id)  ON DELETE SET NULL,
  created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A tombstone, not a delete — the same discipline as messages and
  -- memberships. A client that synced the panel learns it is gone.
  removed_at          TIMESTAMPTZ,

  CONSTRAINT panel_type CHECK (type IN ('chat','web','diff','file','attachment')),

  -- chat_id exactly when type='chat'. The explicit IS NOT NULL / IS NULL is
  -- load-bearing for the same reason as space_visibility (DESIGN.md §13.5).
  CONSTRAINT panel_chat_ref CHECK (
    CASE WHEN type = 'chat' THEN chat_id IS NOT NULL
                            ELSE chat_id IS NULL END)
);

CREATE INDEX panel_space ON panels (space_id) WHERE removed_at IS NULL;

-- One panel per chat. Enforced by the database, like chat_singleton: a chat
-- with two panels would have two places its read state and scroll could live.
CREATE UNIQUE INDEX panel_chat ON panels (chat_id) WHERE type = 'chat';
```

**What is deliberately absent:**

| Absent | Why |
|---|---|
| `visibility` | A chat panel's visibility *is* its chat's `kind`. A shared content panel is visible to the room by definition. Storing it would be a second answer that can disagree with the first. |
| `owner_actor_id` | There is no synced private content panel (§5.3). |
| `space.kind = 'room'` check | Cross-table, so not expressible as a `CHECK`. Enforced in the op (§7.2) and asserted in a test. |
| Position / order | Panel order on screen is per-person view state (§8). Listing order is `created_at`. |

Replica (`workspace.ts`, next version): identical DDL, `INTEGER` timestamps,
`payload TEXT`, no `workspace_id` FK — the same deltas every other replica table
already has.

### 3.3 Types and their payloads

| `type` | `chat_id` | `payload` | Built in |
|---|---|---|---|
| `chat` | the chat | `{}` | Step 2 |
| `web` | — | `{ "url": "https://…" }` | Step 4 |
| `diff` | — | `{ "repo": "…", "base": "sha", "head": "sha" }` or `{ "patch_blob": "sha256" }` | later |
| `file` | — | `{ "path": "src/app.ts" }` in a local room; `{ "blob": "sha256", "name": "…" }` once shared | later |
| `attachment` | — | `{ "message_id": "msg_…", "blob": "sha256" }` | later |

Payloads are validated with zod in `packages/protocol`, one schema per type,
discriminated on `type` — the same pattern as `MessagePart` in `parts.ts`, and
with the same leniency rule: **a client that does not know a type keeps the row
and renders a "this panel needs a newer version" placeholder**, rather than
dropping it. A newer client wrote it; an older one must not destroy it.

Reserving `diff`, `file` and `attachment` in the `CHECK` now costs nothing and
saves a table rebuild on SQLite, where a `CHECK` cannot be altered
(`workspace.ts` version 6 is the cautionary example).

### 3.4 Schema — local panels

`local_panels` lives in **`accounts/<acc>/local-rooms.db`**, beside the local
room tables — *not* in the workspace replica.

```sql
CREATE TABLE local_panels (
  id                  TEXT PRIMARY KEY,     -- pnl_…, kept on share
  workspace_id        TEXT,                 -- NULL for a local room's panel
  space_id            TEXT NOT NULL,        -- a replica space OR a local room space
  type                TEXT NOT NULL,
  payload             TEXT NOT NULL DEFAULT '{}',
  title               TEXT,
  opened_from_chat_id TEXT,
  -- Set while a share is in flight (§5.2). The row is deleted when the ack
  -- lands and the shared row has replicated.
  share_op_id         TEXT,
  created_at          INTEGER NOT NULL,
  last_opened_at      INTEGER NOT NULL,

  -- A local panel is never a chat panel: chats always sync (§4).
  CHECK (type IN ('web','diff','file','attachment'))
);
CREATE INDEX local_panel_space ON local_panels (space_id, last_opened_at DESC);
```

**Why not the replica.** The replica is rebuildable by definition — the server
can recreate `relayed.db` at any time (`STORAGE.md` §5, `LOCAL-ROOMS.md` §4). A
row that only this device holds would be silently erased by the rebuild. Local
panels are ephemeral, but "gone because I closed it" and "gone because the app
rebuilt a database" are different things to the person looking.

**No foreign keys** to `spaces` or `chats`: a synced room's rows are in another
database file. Orphans are swept (§5.5).

**Local rooms** keep both tables in `local-rooms.db`: `panels` (copied DDL, as
with the other room tables) for chat panels and shared-at-publish panels, and
`local_panels` for everything else. One room view reads either scope, per
`LOCAL-ROOMS.md` §11.

---

## 4. Chat panels

### 4.1 Every non-default chat has one

Creating a `public` or `private` chat in a room inserts its panel **in the same
transaction**, with `created_by_actor_id` and `opened_from_chat_id` copied from
the chat's creation. Creating a `default` or `sole` chat never does.

Consequences, all intended:

- There is no "chat without a panel" state to handle.
- `panel_chat` makes a second panel for the same chat impossible.
- Deleting a chat cascades its panel away on both engines.
- The room's panel list is **one query** for chats and content alike.

Existing rooms (none are written by the server today; local rooms exist) are
backfilled by the migration: one `panels` row per non-default chat.

### 4.2 Visibility comes from the chat

```
can_see(actor, chat panel P) ⟺ access(actor, P.chat_id)
```

which is `DESIGN.md` §7.3's predicate, unchanged:

```
access(actor, chat) ⟺ actor ∈ members(workspace)
                     ∧ actor ∈ members(chat.space_id)
                     ∧ (chat.kind ≠ 'private' ∨ actor ∈ members(chat.id))
```

So:

- **A private chat opens in a private panel automatically**, and is seen by
  exactly the private chat's members — an explicit subset, as today.
- **Removing someone from the chat or the room** removes the panel from their
  view by the same rule that removes the chat. No panel-level revocation exists
  to forget.
- **Making the chat public** makes the panel public. There is no separate step.

### 4.3 Converting a private chat to public

`DESIGN.md` §7.3 defines converting a private *room* to public but not a private
*chat*. Panels make this operation ordinary, so it needs defining:

| | Rule |
|---|---|
| Who | The chat's creator, or a room admin |
| Effect | `chats.kind` `private` → `public`; the chat's `scope_type='chat'` membership rows are tombstoned (`left_at`); history becomes readable by every room member |
| Confirmation | Explicit, stating that the whole history is disclosed (`DESIGN.md` §7.4's reasoning) |
| Delivery | Room members who were not chat members receive `gap` + a recent tail (the join case), plus the chat's `panel.created` |
| Reverse (public → private) | **Not offered.** Nothing can be recalled from people who already read it, and offering the button implies otherwise |

This is also the model for sharing a content panel (§5.2): one-way, confirmed,
disclosed.

---

## 5. Content panels: local until shared

### 5.1 Local panels

Opening a URL, a diff, a file or an attachment creates a **local panel**:

- a `local_panels` row, written by the sync engine (the renderer never writes a
  database);
- no outbox op, no network, no event;
- visible only on this device, in the room it was opened in;
- shown as a tab whose title is set in italics, with a **Share** button in the
  tab row while it is the tab shown.

This is the default for every content panel, whoever opens it (§9).

### 5.2 Sharing

**Share** is the only way a content panel reaches anyone else.

```
renderer                sync engine (local-rooms.db + relayed.db)          server
   │ panels.share(pnl_H2) │                                                   │
   │─────────────────────▶│ BEGIN                                             │
   │                      │  UPDATE local_panels SET share_op_id = op_…       │
   │                      │  INSERT INTO panels (id = pnl_H2, … )  ← optimistic
   │                      │  INSERT INTO outbox (kind='panel.share', …)       │
   │                      │ COMMIT        (replica txn; see note below)       │
   │                      │─────────────── op panel.share ───────────────────▶│
   │                      │                                       authorise §6│
   │                      │                                 INSERT panels     │
   │                      │                   append panel.created (space)    │
   │                      │◀────────────── ack + panel.created ───────────────│
   │                      │ DELETE FROM local_panels WHERE id = pnl_H2        │
```

- **The id is kept.** `?p=pnl_H2` in the sharer's URL keeps working across the
  share; a link they paste afterwards works for everyone.
- **The `ops` ledger** gains `panel.share`, so a retried share returns the same
  ack rather than inserting twice (`DESIGN.md` §8.4).
- **Two database files.** `local_panels` and `outbox` are in different files, so
  the write is not one transaction. The order above makes every crash point
  recoverable: the outbox row and the optimistic `panels` row commit together in
  the replica; `share_op_id` on the local row is advisory. On boot, a local panel
  whose id already exists in `panels` is deleted; one with a `share_op_id` whose
  op is gone and whose id is not in `panels` has its `share_op_id` cleared, so
  **Share** reappears.
- **Payload rewrite on share.** Some payloads mean nothing off this device: a
  `file` panel's `{path}` becomes `{blob, name}` (upload first, as publish does
  in `LOCAL-ROOMS.md` §12.3). A `web` panel pointing at a loopback or private
  address shares with a warning: *"localhost:5173 will not open for anyone
  else."* It is flagged, not refused — the URL is still useful context.
- **Local rooms** have no server. Share there flips the row into the local
  `panels` table so it goes with the room at publish (§12).

### 5.3 Why no "synced, private to me"

It is the only cell in §2's grid that needs something new: the space stream
reaches every room member, a private panel must not even be *known* to exist
(`DESIGN.md` §7.2: private chats are fully hidden, for good reason), and the
server has no per-actor stream to put it on.

Building one — `stream_kind='actor'`, its fan-out, its catch-up and its frontier
— is real work in the part of the system where a mistake is a silent permanent
hole (`SYNC-FLOWS.md` §11). The case it serves is "I opened a URL on my laptop
and want it on my other laptop", for a surface described as ephemeral. Not built
until someone asks; §11 records the trigger.

### 5.4 Removing, and not un-sharing

| Action | What happens | Who |
|---|---|---|
| **Close** | Removed from your `?p=`. Nothing is written. | Anyone, always |
| **Remove** a local panel | Row deleted. | You |
| **Remove** a shared content panel | `panel.remove` op → `removed_at` set → `panel.removed` on the space stream. It leaves everyone's tabs. | Its creator, or a room admin |
| **Remove** a chat panel | Not a panel action. Deleting the chat removes it (cascade). | Per chat rules |
| **Un-share** | Not offered. | — |

A client holding `?p=pnl_X` for a removed panel drops the id from the URL on
render — the link degrades rather than misfires (`FRONTEND.md` §4.7's test).

### 5.5 Retention of local panels

- Swept when **not opened for 14 days** (`last_opened_at`), or when their space
  no longer exists in either store.
- Never swept while open in any window.
- Sweeping runs when `local-rooms.db` opens, before anything is on screen; no
  timer. A panel shown in a tab has its `last_opened_at` touched.

The number is a starting point, not a measurement. It is a preference in
`PREFERENCES.md` terms only if someone asks.

---

## 6. Access, in one expression

```
can_see(actor, panel) ⟺
    panel.removed_at IS NULL
  ∧ actor ∈ members(workspace)
  ∧ actor ∈ members(panel.space_id)
  ∧ CASE panel.type
      WHEN 'chat' THEN access(actor, panel.chat_id)
      ELSE             TRUE                        -- shared content: the room
    END
```

Local panels are not in the expression because the server never sees them; on
the device they belong to the signed-in account by construction.

Space membership stays the **leading conjunct** (`AUTHZ.md` invariant 50):
removing someone from a room removes every panel inside it from their view
without touching a panel row.

**Permissions** (additions to `DESIGN.md` §7.3's table):

| Action | Who |
|---|---|
| Open any panel type locally | any room member |
| Share a content panel | any room member |
| Remove a shared content panel | its creator, or a room admin |
| Convert a private chat → public | its creator, or a room admin (§4.3) |

`@relayed/authz` gains `panel.share`, `panel.remove` and `chat.make_public`
evaluated against these rows, with the evaluator's existing test matrix
extended.

---

## 7. Sync

### 7.1 Events

| Event | Stream | Payload | Audience |
|---|---|---|---|
| `panel.created` (type `chat`) | **chat** (`chat_id`) | the row | chat members — so a private chat's panel stays hidden |
| `panel.created` (content) | **space** | the row | room members |
| `panel.removed` (content) | **space** | `{ id }` | room members |

Chat panels have no `panel.removed`: their removal is the chat's removal.

**Why the chat stream for chat panels.** `fanout.ts` already resolves a chat
stream's audience through the chat's access rule, private membership included.
Putting a private chat's panel on the space stream would tell every room member
the private chat exists — the exact leak `DESIGN.md` §7.2 forbids.

> **Found while writing this, and not about panels.** `events.ts` catalogues
> `chat.created` on the **space** stream. That is correct for the only chats the
> server creates now (`sole`, channels only), and it would be the same leak for a
> private room chat. **Guarded:** `ChatCreated.kind` no longer admits `private`,
> so writing one to the space stream is a compile error. Whatever ships private
> chats announces them on the chat stream.

### 7.2 Ops

| Op | Payload | Server does, in one transaction |
|---|---|---|
| `panel.share` | `{ id, space_id, type, payload, title, opened_from_chat_id }` | authorise; check `space.kind='room'`; validate payload by type; insert `panels`; allocate a space rev; append `panel.created`; record in `ops` |
| `panel.remove` | `{ id }` | authorise; set `removed_at`; append `panel.removed`; record in `ops` |
| `chat.make_public` | `{ chat_id }` | authorise; update `chats.kind`; tombstone chat memberships; append `chat.updated` on the space stream **and** `panel.created` on it for non-members; record in `ops` |

`ops.kind` and the replica's `outbox.kind` `CHECK`s widen to include them —
explicitly, as `workspace.ts` version 2's comment promises ("deliberately rather
than by having left it open").

Chat panel creation is not an op of its own: it rides the chat-creation op.

### 7.3 Apply

The replica's apply loop gains three cases; each is an upsert or a tombstone
keyed by panel id, idempotent under at-least-once delivery. An event for a panel
whose chat is not yet held stages like any other out-of-order event
(`staged_events`).

`welcome` includes the caller's visible, non-removed panels per room, alongside
the spaces and chats it already carries — subject to the same size ceiling
(`DESIGN.md` §9.9).

---

## 8. Addressing

`FRONTEND.md` §4.7 holds: **path = identity, query = view state.**

```
/w/:wsId/s/:spaceId                    a space: its sole or default chat in the main pane
/local/s/:spaceId                      the same, for a local room
?p=pnl_A,pnl_B                         the open tabs, in the order they were opened
?p=                                    the panel container open with no tabs
?pa=pnl_A                              the tab shown; omitted when it is the last one
?t=:messageId  ?a=  ?ta=               unchanged, and about the main pane
```

- **No route names a chat.** An earlier draft kept `/s/:spaceId/c/:chatId` for
  working *in* a side chat. A side chat is always a panel, so that is a tab, not
  a place; a chat in the path would be a second answer to "where am I".
- **`?p=` carries panel ids**, not `c:`/`w:` segments. The typed segments
  `LOCAL-ROOMS.md` first proposed existed because the URL had to say which table an id was in;
  with one table (and ids that already say `pnl_`), the row says its type.
- **An empty `?p=` keeps the container open with no tabs.** This is the first-use
  state reached by **Toggle room panels** (`Command+Shift+B` on macOS): it
  offers a side chat and a local web page without creating either one merely
  because the container was opened. Omitting `?p` closes the container.
- **A bare chat id** (`?p=cht_P3`) resolves to that chat's panel, and the URL is
  rewritten to the panel id once the room's panels are read. Links written
  before panels keep working.
- **An id that matches nothing** — a removed panel, or a local panel id in a
  link someone else opens — is dropped from the URL, without a history entry.
- **History.** Opening a panel pushes an entry, so Back undoes it. Switching
  tabs replaces the entry: it is not navigating. Closing the shown tab shows its
  right-hand neighbour, or its left when it was last, as a browser does
  (`closePanelTab` in `shared/panels.ts`).
- **Order, width, and which are open** live in the URL and the resizable layout;
  never stored. Two people in the same room can have entirely different tabs.
- **A room is as you left it.** The URL only holds the room on screen, so each
  room's tabs, the tab shown, and whether the container was open are also kept
  in memory for as long as the app runs (`useOpenPanels`). Closing the container
  hides its tabs rather than forgetting them; **Toggle room panels** brings them
  back. Entering a room with no `?p` in the URL restores it; a URL that names
  panels (Back, a link) wins. Only a room never opened this session falls back
  to its newest panel.
- **Navigation inside a web panel** is device-local and never written
  (`LOCAL-ROOMS.md` §10). Changing a *shared* panel's URL is out of scope for
  v1; share a new panel instead.
- **Not settled: a thread inside a chat panel.** `?t=` is the main pane's. A
  thread opened in a panel would be scoped to it in the query (`pt=pnl_A:msg_…`);
  nothing opens one yet.

---

## 9. Agents

An agent is an actor (`DESIGN.md` §6.3) and follows the same rule as a person:
**what it opens is local to someone, until shared.**

### 9.1 In a synced room — the agent runs on the service

The service cannot create a row on someone's laptop. So an agent that wants a
panel writes a **`panel` message part** (`packages/protocol/src/parts.ts`):

```json
{ "kind": "panel", "type": "web", "payload": { "url": "https://…" }, "title": "Stripe docs" }
```

- It is agent-only, like `tool` and `ui` (`AGENT_ONLY`).
- On the client of **the human the agent acted for** (`on_behalf_of_actor_id`),
  it opens as a local panel automatically — once, keyed by message id, so a
  re-render does not reopen a panel that person closed.
- For everyone else in the chat it renders as a card with **Open** (creates a
  local panel for them) — never an automatic load. An agent must not be able to
  make every member's machine fetch an arbitrary URL, including one that
  resolves to their own `localhost`.
- The agent may *propose* sharing ("Share this to the room?") as a `ui` reply
  action (`AGENT-RESPONSES.md` §6.3). It never shares silently.

Delegation stays chat-scoped: the part lives in the chat, so only people who can
see the chat can see the proposal.

### 9.2 In a local room — the agent runs on this laptop

The agent runner reports the panel intent to the sync engine, which writes the
`local_panels` row directly. Same outcome, no part required — though the part is
still written so the transcript shows *why* a panel appeared.

---

## 10. Rendering

### 10.1 Layout: one container, tabs, one panel shown

```
  ResizablePanelGroup (horizontal)
  ├── "space"   SpaceHeader · ChatView (main chat and composer)
  └── "panels"  while the container is open: 42% to start, 320px at least
                PanelContainer
                ├── tabs exist: tab row · Share · Remove · shown panel body
                └── no tabs: side-chat and web-page choices
```

- **With the container closed, the space takes the whole pane**, header
  included. With the container open, the pane splits: the space keeps its
  header on the left, and the container's header sits in the same line on the
  right. Both rows are the same height, so they read as one bar.
- **An open container with no tabs is useful, not blank.** It offers two
  places to start: an address bar at the top, which opens a web page locally,
  and a public or private side chat, whose choice opens in place into its name
  and privacy. There is no creation dialog. Opening the container alone never
  writes a panel row.
- **One panel is shown at a time.** Opening a panel adds a tab and shows it;
  it never adds a second split.
- **A tab** shows the type's icon (a chat, a private chat, a page) and the
  panel's title — the chat's name, its own title, or the page's host. A local
  panel's title is italic. Close with its ✕ (always shown on the selected tab,
  on hover otherwise) or a middle click.
- **The tab row's actions belong to the shown panel:** **Share** while it is
  local, **Remove** unless it is a chat panel (§5.4).
- **Switching tabs starts the next chat panel fresh:** the body is keyed by panel
  id, so a chat panel's scroll position is not kept across a switch. **A web
  panel is the exception:** every open web tab stays mounted and the ones not
  shown are parked off-screen, because a `<webview>` unmounted or moved loads its
  page again (§10.3). Closing the tab does unmount it.
- **The Panels menu** in the space header lists the room's panels, checked when
  open. Choosing one opens it or shows its tab; choosing the shown tab closes
  it. It also makes a side chat (named, public or private) and opens a web page
  (a bare address is taken as `http` for localhost, `https` otherwise). It
  appears only in a local room: a synced space has no panels to read yet.
- **Toggle room panels** is a route command. `Command+Shift+B` opens the most
  recently created configured panel, or the empty chooser when the room has
  none; invoking it while the container is open closes the whole container.
  The command is active in editable controls because its complete modifier
  chord does not take text from the composer.
- **New panel tab** (`room.panels.newTab`, `Command+T`) is a route command,
  like a browser's new tab, and the same as the tab strip's **+**: the
  container opens (with its remembered tabs, if it was closed) on the new-panel
  tab, whose address bar has the cursor. Enter turns the tab into a web panel —
  the same address already open in the room is that panel. There is no
  address dialog, and no panel row exists until an address is entered, so a
  new tab closed empty leaves nothing behind.

As built: `routes/Space.tsx`, `features/panels/PanelContainer.tsx`,
`PanelMenu.tsx` and `useOpenPanels.ts`. The chat view both panes use is
`features/chat/ChatView.tsx`.

### 10.2 The type registry

A registry in `PanelContainer.tsx` maps `type` → body:

```ts
const PANEL_BODIES: Partial<Record<string, ComponentType<PanelBodyProps>>> = {
  chat: /* ChatView, scoped to the panel's chat */,
  // diff, file, attachment: added with their steps
};
```

A `web` panel is not in the registry: its body is drawn for every open web tab,
not only the shown one (§10.3). An unknown type renders a "needs a newer
version" placeholder (§3.3). A body that throws is caught by a boundary around
it, so the container and the main chat keep working.

### 10.3 Web pages

A web panel is `features/panels/WebPanel.tsx`: a toolbar (back, forward, reload
with a spinner while the page is loading, and an editable address) over a
**`<webview>`** that fills the panel.
When a load fails, a message with **Try again** is drawn over it.

**The address bar** shows where the page is, and takes the person anywhere:
Enter loads what they typed, Escape puts the page's address back. What is typed
goes through `addressFromTyped` (`shared/web-panels.ts`), also used by the Panels
menu: a bare host becomes https (http for localhost), and text that is not an
address — no dot, or a space — becomes a Google search. A scheme other than http
or https is refused in the bar, as main would refuse it anyway. Where the page
goes is never written back to the panel: `payload.url` stays where it was opened,
and browsing inside it is device-local view state (§8).

**Why `<webview>` and not `WebContentsView`.** `LOCAL-ROOMS.md` §10.1 first chose
`WebContentsView`, following Electron's guide. A native view is drawn above the
whole window, which costs two things this layout cannot avoid: every menu,
popover or dialog opened over a page needs the page hidden and a picture drawn
in its place, and every move of the panel — a drag of the split, a resized
sidebar — has to be measured and sent to main. It was built that way first and
replaced before it shipped. A `<webview>` is an element: CSS sizes it, and
anything with a higher z-index draws over it. t3code ships the same choice for
its preview panels (`apps/web/src/browser/HostedBrowserWebview.tsx` there),
which is the evidence that the tag Electron discourages holds up in practice.

**Kept mounted.** A `<webview>` that is unmounted, or moved to another parent,
loads its page again. So the container renders every open web tab in tab order,
and parks the ones not shown at `left: -100000px` with `inert`. Not
`visibility: hidden`: t3code records that Electron can leave a macOS webview
blank for good after it. Closing a tab unmounts its page; leaving the room
unmounts them all. There is no cap: a person has as many pages alive as web tabs
open.

**Checked by main** (`main/web-panels.ts`). The window enables `webviewTag`,
which lets anything running in the window create one, so every attach goes
through `will-attach-webview`:

| Rule | How |
|---|---|
| Only the open account's session | `partition` must equal `persist:panels:<accountId>`, or the attach is refused. Per account, so two accounts' logins do not mix, and never the app's own session |
| Only a web page | `src` must be http or https |
| Nothing of the app's in the page | Any `preload` is deleted; `sandbox`, `contextIsolation`, `webSecurity` forced on, Node integration forced off, whatever the tag asked for |
| No windows | `setWindowOpenHandler` denies every window. A link that wants a tab (`disposition` `foreground-tab` — `target="_blank"`, `window.open()` — or `background-tab`, Cmd+click) is sent to the window as `web-panel:open` with the page's `webContents` id; the panel that owns that page asks its room, which opens the address as a device-local web panel (shown, or added behind for Cmd+click; the same address already open is that tab). Anything else — a popup the page sized, which is how sign-in windows open, and Shift+click (`new-window`) — goes to the system browser, unchanged. `allowpopups` is set on the tag so these reach the handler rather than doing nothing. **Electron has no popup blocker**: a `window.open` with no click behind it reaches the handler exactly as a clicked one, and the handler is not told which it was (measured under Electron 44.2). Nothing extra is added for it; the system-browser path had the same exposure |
| No leaving the web | `will-frame-navigate` and `will-redirect` refuse anything but http and https, in every frame |
| Permissions | Denied, except `clipboard-sanitized-write` — the copy buttons on a dev server's error page need it (t3code found the same). Camera, microphone, location, notifications and clipboard read stay denied |
| User agent | `Electron/…` removed; `Relayed/<version>` kept. Removing both made the agent claim Google Chrome while Client Hints say Chromium, and Google's sign-in refused it as an insecure browser. Named as an app, the way t3code's preview is, it matched t3code, which signs in |
| Downloads | Nothing set: with no save path, Electron asks where to save |

**Measured** in `spikes/web-panels` under Electron 44.2, with the renderer's real
CSP: a `<webview>` loads despite `frame-src 'none'`; a wrong partition, a missing
one, a `file:` source never attach; a requested preload and Node integration are
stripped; `window.open` and `target="_blank"` reach the system browser and open
no window; the app's own scheme is refused while an unguarded page reaches it; an
element above the webview draws over it; a parked webview keeps its page and
draws again; a moved one reloads.

**Open in browser** is the toolbar button after the address bar: the page's
current address, without a text directive, through the `web.openExternal` query
(http and https only).

**Not built:** the
page's title on its tab, shortcuts while the page has focus (key presses go to
the page, not the app's command bus), and pop-out into a window.

---

## 11. Deliberately not built

| Not built | Trigger to build it |
|---|---|
| Synced private content panels (`stream_kind='actor'`) | Someone needs a private panel on a second device, and "share it to a private chat" does not serve |
| Content panels scoped to a private chat's members | Same as above. The workaround — open it from the private chat and share into the room — discloses to the room; if that is the complaint, this is the answer |
| Un-share | Never, for the reason in §5.4 |
| Editing a shared panel's URL / payload | Someone asks for a "pinned, live" dashboard panel that drifts |
| Stored per-room layouts ("open these panels when anyone enters") | A room wants a standing layout, e.g. a runbook |
| `diff`, `file`, `attachment` renderers | Each when its producer exists: diffs from the agent runtime, files from local rooms, attachments from Phase 7 blobs |
| Canvas, live agent-run panel types | Named in `LOCAL-ROOMS.md` §14; a new `type` value when they arrive |

---

## 12. Implementation plan

### 12.1 Spikes first

| Spike | Question | If it fails |
|---|---|---|
| **`<webview>` under the app's window** ✅ `spikes/web-panels`, 19 checks | Does it load under the renderer's CSP? Does the attach check hold? Do elements draw over it? Does parking keep the page? | Answered yes to all; see §10.3. Replaced the `WebContentsView` overlay spike, whose question — does hide-and-snapshot look acceptable under menus — stopped mattering once pages were in the DOM |
| **Many pages** | Memory and process count with 10 web tabs open in one room | Close pages whose tab has not been shown for a while, or cap open web tabs |
| **Two-file share** | Kill the sync engine at each point in §5.2's diagram; does boot recovery leave exactly one panel? | Move `local_panels` into a device-local table in the replica file, excluded from rebuild |

### 12.2 Steps — each usable by hand, each shippable

| # | Step | Touches | Done when |
|---|---|---|---|
| 1 | **Private chats stay hidden.** Move `chat.created` for `kind='private'` to the chat stream; fan-out test that a non-member receives nothing | `server/sync/events.ts`, `fanout.ts`, `spaces.ts` | A room member outside a private chat has no trace of it in their replica |
| 2 | **Chat panels, schema and backfill.** `panels` on server (`009_panels.sql`), replica, and `local-rooms.db`; chat panel inserted with every non-default chat; backfill; `panel.created` on the chat stream; apply + staging; `welcome` carries panels | server migrations + `spaces.ts`; `sync/migrations/workspace.ts`, `local.ts`; `sync/apply.ts`; `sync/local/store.ts`; `packages/protocol` | Replica schema tests pass on both engines, including `panel_chat_ref`'s NULL cases and `panel_chat`'s uniqueness |
| 3 | **Panel container in the room view.** `Panel` read type in the shared read contract; `?p=`/`?pa=` with bare-chat-id fallback; the container with tabs; registry with chat and unknown bodies; `react-resizable-panels` split; close; per-panel error boundary | `renderer/features/panels/*` (new), `renderer/routes/Space.tsx`, sync read contract | A local room's side chats open as tabs by URL; Back closes; a removed id drops out of the URL |
| 4 | **Local web panels, local rooms first.** `local_panels` in `local-rooms.db`; `panels.openLocal` command; main's attach check (`main/web-panels.ts`, §10.3); `WebPanel`; *local* marker; sweep | `sync/local/*`, `main/*`, renderer | Opening a URL in a local room shows it beside the chat; it survives an app restart; it is gone after 14 days unopened |
| 5 | **Local web panels in synced rooms.** Same table, `workspace_id` set; orphan sweep across both stores | `sync/local/store.ts`, renderer | Same as 4, in a synced room, with no network traffic |
| 6 | **Share.** `panel.share` op: authz rule, server op + `ops` ledger, `outbox.kind` widening, optimistic insert, boot recovery, loopback warning; `panel.created` on the space stream; share-at-publish for local rooms | `packages/authz`, `server/sync/ops.ts`, `sync/outbox.ts`, `sync/apply.ts`, `LOCAL-ROOMS` publish manifest | Two clients: A shares, B sees it appear without a reload; killing A mid-share leaves exactly one panel after restart |
| 7 | **Remove.** `panel.remove` op, `panel.removed`, authz (creator or admin) | as 6 | B's open panel closes when A removes it; a non-creator member cannot |
| 8 | **Agent panel parts.** `panel` part in `parts.ts` (agent-only); auto-open for `on_behalf_of` once per message; *Open* card for others; local-room runner writes rows directly | `packages/protocol`, `renderer/features/chat/MessageParts.tsx`, `agent-runner` | An agent opening a URL opens it for the person who asked and shows a card to everyone else |
| 9 | **Make a private chat public.** `chat.make_public` op, confirmation dialog, gap + tail for new viewers | `packages/authz`, `server/sync/*`, renderer | A room member outside the chat gains the chat and its panel with history, after an explicit confirm |
| 10 | **`diff`, `file`, `attachment`.** One renderer and one payload schema each, when their producers exist (§11) | registry + `protocol` | — |

Steps 1–3 are pure structure. Step 4 needed the web page spike's answer.

**Progress (2026-09-14).** The server writes no rooms yet — only channels
(`spaces.ts`; rooms are Phase 5) — so the server and replica halves of steps 1–2,
and steps 5–9, have no writer to exercise them. What landed is the part that has
one:

- **Step 1, as a guard.** `ChatCreated.kind` on the space stream excludes
  `private`, so announcing a private chat there is a compile error.
- **Step 2, local-room half.** `local-rooms.db` version 6: `panels` and
  `local_panels`, with the backfill; `createChat` (side chats, private chat
  memberships, the panel in the same transaction); `panels`, `openLocalPanel`
  (http/https only, deduplicated), `touchLocalPanel`, `sharePanelLocally`,
  `removePanel`, `sweepLocalPanels` (on open). Handlers `local.chats.create` and
  `local.panels.{list,open,touch,share,remove}`, topic `localPanels(spaceId)`.
  Tested per constraint in `sync/local/panels.test.ts`.
- **Before step 3, the route.** Spaces are addressed by id in both scopes —
  `/w/:wsId/s/:spaceId` and `/local/s/:spaceId` — and both stores return one
  `Space` shape (`shared/spaces.ts`), so the room view is one view.
- **Step 3, done** for local rooms, as §8 and §10.1 describe: tabs in one
  container rather than a strip of side-by-side panels. `?p=` parsing,
  resolution and tab closing are tested in `shared/panels.test.ts`. The
  container also has a no-tabs chooser, and the route command toggles it with
  `Command+Shift+B` on macOS.
- **Step 4, done** for local rooms. Local web panels are stored, opened from the
  Panels menu, shared into a local room, removed and swept, and **drawn** as a
  `<webview>` with back, forward and reload (§10.3). The attach check is proven
  in `spikes/web-panels` (`pnpm verify:web-panels`); `shared/web-panels.test.ts`
  covers the URL rule and the partition name. Not yet looked at by hand inside
  the app.
- **Not yet:** server `009_panels.sql` and the replica table (wait for rooms on
  the server), and steps 5–10.

### 12.3 Tests that must exist

- **Schema, both engines:** `panel_chat_ref` with `chat_id` NULL for a chat
  panel and non-NULL for a web panel — both rejected; `panel_chat` rejects a
  second panel for one chat; `local_panels` rejects `type='chat'`.
- **Fan-out:** a private chat's `panel.created` reaches its members only; a
  shared content panel reaches every room member and no one outside the room.
- **Access removal:** removing an actor from the room hides every panel; removing
  them from a private chat hides that chat's panel and nothing else.
- **Share idempotency:** the same `op_id` twice returns the same ack and one row.
- **Share crash recovery:** every crash point in §5.2 converges to one panel.
- **URL degradation:** `?p=` with a removed id, a local id from another device,
  a bare chat id, and an unknown type each render without error.
- **Agent part:** auto-opens once for the delegating human, never for anyone
  else, and not again after that human closes it.

### 12.4 Observability

| Signal | Kind | Why |
|---|---|---|
| `panel.opened` `{type, scope: local\|shared, by: human\|agent}` | event | Whether content panels are really ephemeral — the premise of §5 |
| `panel.shared` `{type, age_s}` | event | How long a panel lives locally before someone shares it; if often immediately, the default is wrong |
| `panel.local.swept` | counter | Retention tuning |
| `panel.share.recovered` `{outcome}` | counter | Should be ~0; nonzero means the two-file write is hurting |
| `web_panel.pages` | gauge | Web pages alive at once, each a process — whether open tabs need a cap (§12.1, many pages) |

Dashboards ship with the metrics (`OBSERVABILITY.md`).

---

## 13. Docs to change when this is accepted

Done for what is built (2026-09-14): `FRONTEND.md` §4.5–§4.7 and §6.1 (routes
by space, panels in the query), `LOCAL-ROOMS.md` §1, §2, §6, §9, §10, §11.3,
§12 and §13 (`pages` replaced by panels; §10.1 and §13 again for `<webview>`
replacing `WebContentsView`), and `AGENT-RESPONSES.md` §6.3. The rest waits on
the synced half.

| Doc | Change |
|---|---|
| `DESIGN.md` §7.1–§7.3 | Add panels to the containment diagram; add §4.3's chat conversion and §6's permissions |
| `DESIGN.md` §10.3 | Op kinds: `panel.share`, `panel.remove`, `chat.make_public` |
| `AGENT-RESPONSES.md` §6.3 | Add the `panel` part (step 8) |
| `SYNC-FLOWS.md` | Panel events per stream; private `chat.created` on the chat stream |
| `AUTHZ.md` | The three new actions |

---

## 14. Open questions

1. **Retention number.** 14 days unopened is a guess. §12.4's `panel.shared
   {age_s}` will say whether it is close.
2. **Who removes a shared panel.** Creator or admin is the conservative choice.
   Rooms are small and topic-scoped; "any member" may be friendlier and is
   reversible by re-sharing.
3. **Does a shared web panel's navigation ever sync?** No for v1 (§8). A "follow
   me" presentation mode is a different feature, with presence rather than rows.
4. **Private-chat-scoped content panels.** The strongest candidate for §11's
   first un-deferral: a diff shared "into this private chat" rather than into the
   room. If it comes, it is a nullable `scope_chat_id` on `panels` riding the
   chat stream — no new stream, which is why it is cheaper than §5.3.
