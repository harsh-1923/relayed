# Panels

> **Status: a proposal, not yet the design of record.** Nothing in this document
> is built. It replaces the *page* object in [`LOCAL-ROOMS.md`](LOCAL-ROOMS.md)
> §10 and extends the room model in [`DESIGN.md`](DESIGN.md) §7. §13 lists the
> edits those documents need; until they land, they win.

**Last updated:** 2026-09-14

---

## 0. Words used here

| Word | Meaning here |
|---|---|
| **Room** | A space with `kind='room'`: one default chat plus any number of public and private chats (`DESIGN.md` §7.1–§7.2). |
| **Main pane** | What the route addresses. In a room, the default chat — or a side chat when someone is working *in* it (`/c/:chatId`). |
| **Panel** | A surface open beside the main pane, inside a room. It has a **type**: `chat`, `web`, `diff`, `file`, `attachment`, and more later. |
| **Chat panel** | A panel whose content is one of the room's non-default chats. |
| **Content panel** | Every panel that is not a chat panel: a web page, a diff, a file, an attachment. |
| **Local panel** | A panel that exists only on this device. Nobody else knows it exists, including the server. |
| **Shared panel** | A panel synced to the room. Everyone entitled to it receives it. |
| **Share** | Turning a local panel into a shared one. One-way. |
| **Open / closed** | Whether a panel is on *your* screen right now. View state, carried in the URL, never stored. |
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
| What does the URL carry? | **Panel ids**: `?p=pnl_A,pnl_B`. A bare chat id still resolves to that chat's panel. | 8 |
| What happens when an agent opens a URL? | It writes a **panel part** into its message. Clients turn it into a local panel for the person the agent acted for; everyone else sees a link. | 9 |
| How is a web page rendered? | `WebContentsView`, exactly as `LOCAL-ROOMS.md` §10.4 already specifies. Unchanged. | 10 |

---

## 2. The idea in one picture

```
  room: "checkout-bug"
  ┌──────────────────────────────┬───────────────────────┬───────────────────────┐
  │ main pane                    │ panel                 │ panel                 │
  │                              │                       │                       │
  │ default chat                 │ chat: "try fix B"     │ web: localhost:5173   │
  │ (never a panel)              │ private chat → only   │ LOCAL → only on this  │
  │                              │ its members see it    │ laptop, nobody else   │
  │                              │ SYNCED                │ knows it exists       │
  │                              │                       │   [ Share to room ]   │
  └──────────────────────────────┴───────────────────────┴───────────────────────┘

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
- listed in the room's panel strip with a *local* marker and a **Share** button.

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
| **Remove** a shared content panel | `panel.remove` op → `removed_at` set → `panel.removed` on the space stream. It leaves everyone's strip. | Its creator, or a room admin |
| **Remove** a chat panel | Not a panel action. Deleting the chat removes it (cascade). | Per chat rules |
| **Un-share** | Not offered. | — |

A client holding `?p=pnl_X` for a removed panel drops the id from the URL on
render — the link degrades rather than misfires (`FRONTEND.md` §4.7's test).

### 5.5 Retention of local panels

- Swept when **not opened for 14 days** (`last_opened_at`), or when their space
  no longer exists in either store.
- Never swept while open in any window.
- Sweeping runs with the existing replica maintenance tick; no new timer.

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

> **Found while writing this, and not about panels.** `events.ts` today catalogues
> `chat.created` on the **space** stream. That is correct for the only chats the
> server creates now (`sole`, channels only), and it is the same leak for a
> private room chat. Whatever ships private chats must move `chat.created` for
> `kind='private'` to the chat stream. Panels depend on it; it is listed as step 1
> so it is not discovered later.

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
/w/:wsId/s/:spaceId                    room, default chat in the main pane
/w/:wsId/s/:spaceId/c/:chatId          working IN a side chat
?p=pnl_A,pnl_B                         panels open beside the main pane, in order
?t=:messageId  ?a=  ?ta=               unchanged
```

- **`?p=` carries panel ids**, not `c:`/`w:` segments. `LOCAL-ROOMS.md` §10.2's
  typed segments existed because the URL had to say which table an id was in;
  with one table (and ids that already say `pnl_`), the row says its type.
- **A bare chat id** (`?p=cht_P3`) resolves through `panel_chat` to that chat's
  panel. Links written before panels keep working.
- **A local panel id** in a link someone else opens resolves to nothing and is
  dropped from the URL. Expected: the panel is not theirs.
- **Order, width, and which are open** live in the URL and the resizable layout;
  never stored. Two people in the same room can have entirely different panels
  open.
- **Navigation inside a web panel** is device-local and never written
  (`LOCAL-ROOMS.md` §10.3). Changing a *shared* panel's URL is out of scope for
  v1; share a new panel instead.

Local rooms keep their scheme: `#/local/s/:spaceId?p=pnl_…`.

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

A registry in the renderer maps `type` → component:

```ts
const PANEL_RENDERERS = {
  chat: ChatPanel,          // the existing Chat view, scoped to chat_id
  web:  WebPanel,           // WebContentsView host (LOCAL-ROOMS.md §10.4)
  // diff, file, attachment: added with their steps
} satisfies Partial<Record<PanelType, PanelRenderer>>;
```

An unknown type renders `UnknownPanel` (§3.3). A renderer that throws is caught
per panel; its siblings keep rendering.

**Web panels** use `WebContentsView` exactly as `LOCAL-ROOMS.md` §10.4
specifies — own session partition per account, sandboxed, no preload, window
opens and app schemes refused, permissions denied, downloads prompted, hidden
rather than destroyed on close, a capped LRU of hidden views, and the overlay
problem resolved by the spike (§12.1). Nothing in that section changes except
the object it renders: a panel row, not a page row.

**Panel chrome** (shared by every type): title, type icon, *local* marker, and
actions — Share (local only), Remove (per §5.4), Close, Pop out.

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
| **`WebContentsView` overlays** (already in `LOCAL-ROOMS.md` §13.1) | Does hide-and-snapshot look acceptable under menus and dialogs? Do bounds keep up with `react-resizable-panels` during a drag? | Web panels open in a separate window; the panel shows a placeholder with *Focus window* |
| **Many views** | Memory and process count with 5 open and 10 hidden web panels | Lower the LRU cap; destroy on close |
| **Two-file share** | Kill the sync engine at each point in §5.2's diagram; does boot recovery leave exactly one panel? | Move `local_panels` into a device-local table in the replica file, excluded from rebuild |

### 12.2 Steps — each usable by hand, each shippable

| # | Step | Touches | Done when |
|---|---|---|---|
| 1 | **Private chats stay hidden.** Move `chat.created` for `kind='private'` to the chat stream; fan-out test that a non-member receives nothing | `server/sync/events.ts`, `fanout.ts`, `spaces.ts` | A room member outside a private chat has no trace of it in their replica |
| 2 | **Chat panels, schema and backfill.** `panels` on server (`009_panels.sql`), replica, and `local-rooms.db`; chat panel inserted with every non-default chat; backfill; `panel.created` on the chat stream; apply + staging; `welcome` carries panels | server migrations + `spaces.ts`; `sync/migrations/workspace.ts`, `local.ts`; `sync/apply.ts`; `sync/local/store.ts`; `packages/protocol` | Replica schema tests pass on both engines, including `panel_chat_ref`'s NULL cases and `panel_chat`'s uniqueness |
| 3 | **Panel strip in the room view.** `Panel` read type in the shared read contract; `?p=` parsing with bare-chat-id fallback; registry with `ChatPanel` and `UnknownPanel`; `react-resizable-panels` layout; close; per-panel error boundary | `renderer/features/rooms/*` (new), `renderer/app/router.tsx`, sync read contract | A local room's side chats open as panels by URL; back closes; a removed id drops out of the URL |
| 4 | **Local web panels, local rooms first.** `local_panels` in `local-rooms.db`; `panels.openLocal` command; main's view manager (`main/views.ts`) with the §10.4 security settings; `WebPanel`; *local* marker; sweep | `sync/local/*`, `main/*`, `preload`, renderer | Opening a URL in a local room shows it beside the chat; it survives an app restart; it is gone after 14 days unopened |
| 5 | **Local web panels in synced rooms.** Same table, `workspace_id` set; orphan sweep across both stores | `sync/local/store.ts`, renderer | Same as 4, in a synced room, with no network traffic |
| 6 | **Share.** `panel.share` op: authz rule, server op + `ops` ledger, `outbox.kind` widening, optimistic insert, boot recovery, loopback warning; `panel.created` on the space stream; share-at-publish for local rooms | `packages/authz`, `server/sync/ops.ts`, `sync/outbox.ts`, `sync/apply.ts`, `LOCAL-ROOMS` publish manifest | Two clients: A shares, B sees it appear without a reload; killing A mid-share leaves exactly one panel after restart |
| 7 | **Remove.** `panel.remove` op, `panel.removed`, authz (creator or admin) | as 6 | B's open panel closes when A removes it; a non-creator member cannot |
| 8 | **Agent panel parts.** `panel` part in `parts.ts` (agent-only); auto-open for `on_behalf_of` once per message; *Open* card for others; local-room runner writes rows directly | `packages/protocol`, `renderer/features/chat/MessageParts.tsx`, `agent-runner` | An agent opening a URL opens it for the person who asked and shows a card to everyone else |
| 9 | **Make a private chat public.** `chat.make_public` op, confirmation dialog, gap + tail for new viewers | `packages/authz`, `server/sync/*`, renderer | A room member outside the chat gains the chat and its panel with history, after an explicit confirm |
| 10 | **`diff`, `file`, `attachment`.** One renderer and one payload schema each, when their producers exist (§11) | registry + `protocol` | — |

Steps 1–3 are pure structure and can land before the overlay spike resolves.
Step 4 is where the spike's answer is needed.

**Progress (2026-09-14).** The server writes no rooms yet — only channels
(`spaces.ts`; rooms are Phase 5) — so the server and replica halves of steps 1–2
have no writer to exercise them. What landed is the part that has one:

- **Step 1, as a guard.** `ChatCreated.kind` on the space stream excludes
  `private`, so announcing a private chat there is a compile error.
- **Step 2, local-room half.** `local-rooms.db` version 6: `panels` and
  `local_panels`, with the backfill; `createChat` (side chats, private chat
  memberships, the panel in the same transaction); `panels`, `openLocalPanel`
  (http/https only, deduplicated), `touchLocalPanel`, `sharePanelLocally`,
  `removePanel`, `sweepLocalPanels` (on open). Handlers `local.chats.create` and
  `local.panels.{list,open,touch,share,remove}`, topic `localPanels(spaceId)`.
  Tested per constraint in `sync/local/panels.test.ts`.
- **Not yet:** server `009_panels.sql` and the replica table (wait for rooms on
  the server), and everything from step 3 on.

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
| `web_panel.views` | gauge | Process count against the LRU cap |

Dashboards ship with the metrics (`OBSERVABILITY.md`).

---

## 13. Docs to change when this is accepted

| Doc | Change |
|---|---|
| `DESIGN.md` §7.1–§7.3 | Add panels to the containment diagram; add §4.3's chat conversion and §6's permissions |
| `DESIGN.md` §10.3 | Op kinds: `panel.share`, `panel.remove`, `chat.make_public` |
| `LOCAL-ROOMS.md` §1, §10.2–§10.3, §12 manifest, §13.2 step 7 | Replace `pages` with `panels` / `local_panels`; `?p=` carries panel ids |
| `AGENT-RESPONSES.md` §6.3 | `Link` → "Open as panel"; add the `panel` part |
| `FRONTEND.md` §4.7 | `?p=` carries panel ids, with the bare-chat-id fallback |
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
