-- The event log: what HAPPENED, beside the tables that say what is TRUE NOW.
-- Step 4 of the sync build plan (docs/SYNC-FLOWS.md §2).
--
-- Why this table exists when `messages` already carries a `rev`. A row records
-- current state and structurally cannot record history, because each mutation
-- overwrites the evidence of the last one. Take a chat whose life is:
--
--     rev 1  m1 created      rev 2  m2 created      rev 3  m1 edited
--     rev 4  m3 created      rev 5  m1 deleted
--
-- The ROWS afterwards hold m1@rev5, m2@rev2, m3@rev4. A client catching up from
-- zero therefore learns revisions 2, 4 and 5 — revisions 1 and 3 exist nowhere.
-- It hears of m1 only as the deletion of a message it never saw created.
--
-- Two consequences, and the second is the one that bites in this phase:
--
--   * the moment edits land (Phase 4), row-derived catch-up is unsound;
--   * a space rename, a chat added to a room, a member added or removed, an
--     actor deactivated — NONE of these live in `messages`, so none of them has
--     any catch-up path at all today. That is not a future problem.
--
-- Full reasoning in the sync flows doc's catch-up section, "why sync_events and
-- not the message rows" (docs/SYNC-FLOWS.md §12.1).

CREATE TABLE sync_events (
  event_id     TEXT PRIMARY KEY,        -- ULID, evt_… — see the retention note
  -- Denormalised deliberately. Fanout resolves an event's audience and then
  -- filters connections by workspace (docs/SYNC-FLOWS.md §7), and a tenant sweep
  -- wants to scope by it. Both would otherwise join through the stream's own
  -- table on the hottest path in the system.
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- The stream this event is ordered within. NOT a foreign key: the target
  -- table varies by `stream_kind`, which is precisely what an FK cannot express.
  -- The CHECK below is what keeps the column honest instead.
  stream_kind  TEXT NOT NULL,
  stream_id    TEXT NOT NULL,
  -- Allocated by the same UPDATE … RETURNING that locks the stream's row, so it
  -- is unique and gapless per stream by construction rather than by convention.
  stream_rev   BIGINT NOT NULL,

  event_type   TEXT NOT NULL,
  -- A WIRE shape, not a row dump. Never populated from SELECT *: a column added
  -- to `messages` later would otherwise start shipping to every client, and
  -- some of those columns must not (`on_behalf_of_actor_id` before delegation
  -- is a product, for one).
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 'actor' is deliberately absent. An actor stream is a delivery ADDRESS, not
  -- an ordered stream: everything addressed to one — read state from another
  -- device, counter snapshots — is a max-register or a projection, converging
  -- without order and repairing itself on the next `welcome`. Nothing in this
  -- phase needs a cursor over it, so it gets no counter and no rows here.
  -- Notifications may change that in Phase 7; adding a value to this CHECK and
  -- a column to `actors` is a cheap migration, and a stream kind nothing writes
  -- is a constraint nothing has ever exercised.
  CONSTRAINT sync_event_kind CHECK (stream_kind IN ('chat', 'space', 'workspace')),
  -- Revisions are 1-based: a stream's counter starts at 0 and every allocation
  -- pre-increments, so rev 0 means "nothing has happened here" and can never
  -- name an event. A client's cursor starts at 0 for the same reason.
  CONSTRAINT sync_event_rev CHECK (stream_rev > 0),

  -- ONE index for the hot path, and this constraint is it. Catch-up asks
  -- `stream_kind = ? AND stream_id = ? AND stream_rev > ? ORDER BY stream_rev`,
  -- which is an exact prefix seek on the unique index Postgres builds for this
  -- constraint. A second index on the same columns would be pure write cost.
  --
  -- `workspace_id` is NOT in this key, though an earlier draft led with it.
  -- Stream ids are globally unique prefixed ULIDs, so it adds no uniqueness —
  -- and as the leading column it would force every reader to carry a workspace
  -- it does not otherwise need, while a B-tree cannot seek without its first
  -- column. Authorization already scopes the read: a caller reaches catch-up
  -- only by passing can(), which is membership-based and therefore
  -- workspace-bound.
  CONSTRAINT sync_event_stream UNIQUE (stream_kind, stream_id, stream_rev)
);

-- RETENTION, noted here because the shape is decided by this table rather than
-- by the sweep that will use it (step 12 of the plan).
--
-- Sweep by `event_id`, not by `created_at`. A ULID is time-ordered and its
-- prefix is constant, so "older than T" is a keyset range over the PRIMARY KEY
-- — no second index, and no second index to add later. That matters more than
-- it looks: this runner wraps each migration in a transaction, CREATE INDEX
-- CONCURRENTLY cannot run inside one, and this is the table most likely to be
-- large by the time anyone wants an index on it (the same trap recorded in
-- 007_chat_workspace_index.sql).

-- ─── Stream counters ────────────────────────────────────────────────────────
-- `chats.next_rev` already exists from 005_sync.sql. These are its siblings,
-- and they are allocated by the identical `SET next_rev = next_rev + 1 …
-- RETURNING` form — which takes a row lock, so a second transaction blocks and
-- then adds to the committed value. Read-then-write here because "spaces are
-- low-traffic" would be the same lost update it is on a chat, and a lost update
-- on a rev silently REUSES one, which is worse than losing one: two different
-- events would claim the same position in a client's cursor.
--
-- DEFAULT 0 with a NOT NULL is a metadata-only change in Postgres 11+, so this
-- does not rewrite either table.
ALTER TABLE spaces     ADD COLUMN next_rev BIGINT NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN next_rev BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN spaces.next_rev IS
  'Sync revision counter for the space:<id> stream — renames, membership, chats.';
COMMENT ON COLUMN workspaces.next_rev IS
  'Sync revision counter for the workspace:<id> stream — the actor directory, '
  'and nothing else. It is the one workspace-wide stream, and it earns that '
  'only because every member is entitled to all of it, so the cursor has no '
  'holes to contain.';
