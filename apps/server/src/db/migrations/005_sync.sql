-- Phase 2, step A: the log's schema (docs/PHASE-2-SYNC.md §3).
--
-- Schema only. Allocating `ord`/`rev` is step B and the domain ops are step C;
-- nothing here knows how to write a message. Splitting them is what makes a
-- failure in B attributable to B.
--
-- The client mirrors a subset of this in the workspace replica (DESIGN.md §8.3).
-- Where the two differ, it is because the server owns something the client only
-- receives — allocation counters, the idempotency ledger, per-actor counters.

-- ─── Spaces: channels, DMs, group DMs and rooms in ONE table ─────────────────
-- Discriminated by `kind` (DESIGN.md §7.1). The structure genuinely is uniform —
-- every one of them is "a container of chats with a member list" — and only
-- policy differs, so the structure unifies and the policy varies by kind.
--
-- The alternative, three parent tables, was rejected for a concrete reason: the
-- access predicate needed four branches instead of one expression, and
-- `chats.space_id` could not be a real foreign key because its target varied by
-- row. It is a real foreign key below.
--
-- Phase 2 writes only kind='channel'. The rest of the matrix is here because
-- adding it later is a migration and carrying it now is free.
CREATE TABLE spaces (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id)    ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  name                TEXT,                    -- NULL for dm/group_dm: derived from members
  slug                TEXT,                    -- channels only
  topic               TEXT,
  visibility          TEXT,                    -- NULL for dm/group_dm
  membership_policy   TEXT NOT NULL,
  lifecycle           TEXT NOT NULL DEFAULT 'active',
  created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  -- Drives auto-dormancy (DESIGN.md §7.5). Automatic inactivity produces
  -- `dormant`, never `archived`: dormancy is non-destructive by construction —
  -- posting wakes the space — so it can never lock anyone out of a room they
  -- still need. `archived` is only ever a deliberate human act.
  last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT space_kind      CHECK (kind IN ('channel','dm','group_dm','room')),
  CONSTRAINT space_policy    CHECK (membership_policy IN ('open','invite','sealed')),
  CONSTRAINT space_lifecycle CHECK (lifecycle IN ('active','dormant','archived')),

  -- `sealed` is what prevents adding a third person to a DM: adding someone
  -- creates a NEW conversation rather than mutating the existing one.
  CONSTRAINT space_dm_sealed CHECK (kind NOT IN ('dm','group_dm')
                                    OR membership_policy = 'sealed'),
  CONSTRAINT space_dm_lifecycle CHECK (kind NOT IN ('dm','group_dm')
                                       OR lifecycle <> 'archived'),

  -- NOTE the explicit IS NOT NULL, in both of the constraints below.
  --
  -- A CHECK rejects a row only when it evaluates to FALSE, and a CHECK that
  -- evaluates to NULL PASSES. Since `NULL IN (...)` is NULL, the natural
  -- spelling silently permits exactly the row it is written to forbid — a
  -- channel with no visibility at all. Both wrong spellings look obviously
  -- correct and neither fails loudly (DESIGN.md §13.5), which is why each of
  -- these has a test of its own asserting the NULL case.
  CONSTRAINT space_visibility CHECK (
    CASE WHEN kind IN ('dm','group_dm')
         THEN visibility IS NULL
         ELSE visibility IS NOT NULL AND visibility IN ('public','private') END),
  CONSTRAINT space_named CHECK (
    CASE WHEN kind IN ('dm','group_dm') THEN TRUE
                                        ELSE name IS NOT NULL END)
);
CREATE INDEX space_workspace ON spaces (workspace_id, kind);
CREATE UNIQUE INDEX space_slug ON spaces (workspace_id, slug) WHERE slug IS NOT NULL;

-- ─── Chats: THE universal message container (DESIGN.md §7.1) ────────────────
-- Every message lives in a chat; nothing references a space directly. Channels,
-- DMs and group DMs have exactly one ('sole'); a room has a 'default' plus any
-- number of 'public' and 'private' ones.
--
-- The chat is the SYNC unit and its space is the PERMISSION unit. Keeping those
-- separate is what gives the whole product one message pipeline instead of four.
CREATE TABLE chats (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id            TEXT NOT NULL REFERENCES spaces(id)     ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  name                TEXT,                    -- NULL for 'sole' and 'default'

  -- Allocation counters (DESIGN.md §8.4). Step B bumps both under a per-chat
  -- lock inside the same transaction as the insert; that serialises writes per
  -- chat, which is the property we want rather than a bottleneck at team scale.
  --
  -- TWO counters, and they are not interchangeable. `next_ord` advances only
  -- when a message is created — display order, read cursor, retention boundary,
  -- backfill paging. `next_rev` advances on ANY mutation and is the sync cursor
  -- and nothing else. One counter cannot do both jobs: an edit would mark a
  -- chat unread for everyone and could move the message (DESIGN.md §8.1).
  next_ord            BIGINT NOT NULL DEFAULT 0,
  next_rev            BIGINT NOT NULL DEFAULT 0,

  created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chat_kind CHECK (kind IN ('sole','default','public','private'))
);
CREATE INDEX chat_space ON chats (space_id);

-- Structural singleton: exactly one 'sole' chat per channel/dm/group_dm, and
-- exactly one 'default' chat per room. Enforced by the database rather than by
-- application logic, because a room whose shared floor can be deleted — or a
-- channel with two message lists — has no coherent meaning.
CREATE UNIQUE INDEX chat_singleton ON chats (space_id) WHERE kind IN ('sole','default');

-- ─── Messages ───────────────────────────────────────────────────────────────
CREATE TABLE messages (
  -- CLIENT-generated ULID (DESIGN.md §10.1). Not a server sequence, ever: you
  -- must be able to create a referencable entity while disconnected, because a
  -- user composes offline and then deletes what they composed, and both ops
  -- need a stable target the server has never heard of.
  id                    TEXT PRIMARY KEY,
  chat_id               TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  -- NULL = top-level; otherwise the thread root. Threads are Phase 4, but the
  -- column and its index are here because replies share the chat's ord space
  -- and adding the column later would rewrite the table (DESIGN.md §8.2).
  parent_id             TEXT REFERENCES messages(id) ON DELETE SET NULL,

  ord                   BIGINT NOT NULL,
  rev                   BIGINT NOT NULL,

  -- RESTRICT, not CASCADE: no actor may be removed out from under the history
  -- they wrote. Deactivation tombstones the actor and keeps their messages
  -- (DESIGN.md §6.3), so nothing in normal operation trips this.
  --
  -- The consequence, worth knowing before writing tenant offboarding: deleting
  -- an organization in ONE statement fails. It cascades to `actors` down one
  -- path and to `messages` down another, and Postgres promises no order between
  -- them. Stage it — delete the workspace's spaces first, which cascades to
  -- chats and messages, then the organization. Asserted in sync-schema.test.ts.
  author_id             TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  -- Mentions are stored as `<@actor_id>` markup, never as a handle: a rename
  -- would otherwise orphan every historical mention, and a reused handle would
  -- silently redirect one (PHASE-1-IDENTITY.md §10).
  body                  TEXT NOT NULL,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at             TIMESTAMPTZ,
  -- A tombstone, not a delete. The row stays and KEEPS ITS `ord`, so the gap it
  -- leaves in the sequence is normal rather than something to repair — `ord` is
  -- never renumbered or reused, or read cursors and scroll positions corrupt
  -- across clients. The body is cleared at delete time rather than retained.
  deleted               BOOLEAN NOT NULL DEFAULT FALSE,

  -- Delegation attribution (DESIGN.md §6.4). `author_id` is ALWAYS the acting
  -- actor — for an agent reply that is the agent, never the human;
  -- `on_behalf_of_actor_id` records whose authority was spent. Both NULL for an
  -- ordinary human message. Phase 6 populates them; the columns are here so
  -- that phase is not a table rewrite.
  on_behalf_of_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  delegation_id         TEXT
);

-- One message per ordinal per chat. This is the index that makes "ord is never
-- reused" an enforced fact rather than a convention.
CREATE UNIQUE INDEX msg_ord ON messages (chat_id, ord);

-- The chat view must skip thread replies WITHOUT scanning past them. Without
-- the partial index, "last 50 chat messages" in a chat holding a thread with
-- 800 replies scans 800 rows it will discard.
CREATE INDEX msg_chat_view ON messages (chat_id, ord DESC) WHERE parent_id IS NULL;
CREATE INDEX msg_thread    ON messages (parent_id, ord)    WHERE parent_id IS NOT NULL;

-- Catch-up reads by rev, not by ord: "give me everything since rev N" returns
-- messages and deletes in one ordered stream (DESIGN.md §9.3).
CREATE INDEX msg_rev ON messages (chat_id, rev);

-- ─── Idempotency ledger ─────────────────────────────────────────────────────
-- A retried op must return the SAME ack, not do the work twice (DESIGN.md §8.4).
-- Without this, a client that sends, loses the connection before the ack, and
-- retries produces a duplicate message — the single most common offline-sync bug
-- in the wild.
--
-- A ledger rather than a unique column on `messages`, because a delete is an op
-- too and inserts no row. Every op kind gets the same protection from one place.
CREATE TABLE ops (
  op_id      TEXT PRIMARY KEY,        -- client-generated ULID
  -- Recorded so a replay can be matched against its ORIGINAL sender. op_id is
  -- chosen by a client, so without this a second actor could present someone
  -- else's op_id and be handed their ack — which names a message they may not
  -- be able to see. Step B compares both and rejects a mismatch; the column is
  -- what makes that possible.
  actor_id   TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  chat_id    TEXT NOT NULL REFERENCES chats(id)  ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  -- The ack, verbatim. Replaying returns this rather than recomputing it, so a
  -- retry cannot produce a different `ord` from the one already delivered.
  result     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT op_kind CHECK (kind IN ('send','delete'))
);
CREATE INDEX op_chat ON ops (chat_id, created_at);

-- ─── Per-(actor, chat) read state and counters (DESIGN.md §12) ──────────────
-- The server owns these. Arithmetic alone cannot produce them: mention counts
-- need message bodies the client does not hold, thread unread cannot be derived
-- because threads share the chat's ord space, and deletes leave ord gaps that
-- break the subtraction.
--
-- This is what makes R2 cheap. A badge is correct for a chat holding ZERO
-- messages locally, which is exactly the unopened-chat case.
CREATE TABLE chat_read_state (
  chat_id       TEXT NOT NULL REFERENCES chats(id)  ON DELETE CASCADE,
  actor_id      TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,

  -- A MAX-register, never LWW (DESIGN.md §4). Applied as max(existing,
  -- incoming): an actor reads on their laptop, then their phone — asleep for an
  -- hour with stale state — reconnects and syncs. Under LWW the phone's older
  -- value wins and the chat goes unread again. Users find that maddening, and
  -- it is trivially avoided.
  last_read_ord BIGINT NOT NULL DEFAULT 0,

  chat_unread   INTEGER NOT NULL DEFAULT 0,
  thread_unread INTEGER NOT NULL DEFAULT 0,
  mention_count INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (chat_id, actor_id)
);
CREATE INDEX chat_read_state_actor ON chat_read_state (actor_id);
