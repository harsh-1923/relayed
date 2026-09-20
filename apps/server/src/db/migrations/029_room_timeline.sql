-- The room timeline: how a room has progressed, as rows (docs/MEMORY.md §14.3).
--
-- An episode is ALREADY a timeline entry. Memory cuts one at the first quiet
-- gap, so it arrives with a time range, participants, an ord range — meaning a
-- click needs no second lookup — and, after ingest, its facts. This table is
-- that episode written down for people to read, and nothing more.
--
-- APPEND-ONLY, WRITTEN ONCE. The summariser this replaces re-read four hundred
-- messages on a schedule to restate current state, and drifted, which is why it
-- needed a rebuild window. An entry describes a stretch of time that has
-- already happened, so there is nothing for it to drift from. Only the header
-- in `documents` is ever regenerated.
--
-- A PROJECTION, NEVER A SOURCE OF TRUTH. No agent reads it and no recall
-- touches it. That is what licenses it to hold a second copy of the fact text
-- beside Hindsight's: it cannot disagree with anything, because nothing depends
-- on it.
--
-- Separate from `memory_documents` (026) though it is 1:1 with it, because that
-- table holds a VENDOR'S identifiers and this one is replicated member data.
-- Merging them would put Hindsight's ids into the sync protocol and into every
-- client's SQLite, permanently, and that is not removable later.
CREATE TABLE room_timeline_entries (
  -- tle_…, a ULID.
  id                TEXT NOT NULL PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id          TEXT NOT NULL REFERENCES spaces(id)     ON DELETE CASCADE,
  chat_id           TEXT NOT NULL REFERENCES chats(id)      ON DELETE CASCADE,

  -- Where in the conversation, so opening the entry needs no lookup.
  ord_start         INTEGER NOT NULL,
  ord_end           INTEGER NOT NULL,
  -- Nullable for the same reason `documents.updated_by_actor_id` is: the entry
  -- outlives the message it points at, and a dangling jump is better than a
  -- cascade that takes the entry with it.
  anchor_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,

  -- When it HAPPENED — the messages' own time, never the ingest time. A
  -- timeline that reorders itself because a backfill ran late is not a
  -- timeline, and ingestion is explicitly allowed to lag (§6.1).
  occurred_start    TIMESTAMPTZ NOT NULL,
  occurred_end      TIMESTAMPTZ NOT NULL,

  title             TEXT  NOT NULL,
  -- [{ text, message_id, kind }] — the facts as bullets, each still carrying
  -- the message it came from, which is the same anchor §7.2 cites with.
  facts             JSONB NOT NULL DEFAULT '[]',
  -- Actor ids, for the faces. An array rather than a join table: it is a fixed
  -- historical list, never queried across entries, and read only to draw them.
  participants      JSONB NOT NULL DEFAULT '[]',

  -- The highest-ranked fact kind in this entry, for the "Decisions only"
  -- filter. `episode` means UNCLASSIFIED, not uninteresting: the extraction
  -- mission steers toward decisions and ownership in prose but nothing labels
  -- what comes back, so how this is filled is still open (§14.5).
  --
  -- NO CHECK, the rule `documents` and `panels` already hold: a kind this build
  -- does not know is kept and drawn as a placeholder, never dropped, because a
  -- newer server sent it. A replica CHECK that can refuse what the server
  -- legitimately wrote is a liveness bug by construction (workspace.ts v19).
  kind              TEXT    NOT NULL DEFAULT 'episode',
  significance      INTEGER NOT NULL DEFAULT 0,

  -- A TOMBSTONE, not a delete, and the same shape `messages` uses. Forgetting
  -- runs through here: a deleted message re-retains its episode without it, and
  -- an episode left with nothing is tombstoned rather than removed. Keeping the
  -- row is what lets `rev` stay monotonic, so an update that arrives late
  -- cannot resurrect it on a replica that has already applied the removal.
  deleted           BOOLEAN NOT NULL DEFAULT false,

  -- Monotonic per entry, `documents.rev`'s rule: every write increments it and
  -- every reader keeps the highest it has seen.
  rev               INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT room_timeline_ords CHECK (ord_end >= ord_start),
  CONSTRAINT room_timeline_rev  CHECK (rev >= 1)
);

-- The panel's only query: one space, newest first, paged.
CREATE INDEX room_timeline_by_space ON room_timeline_entries (space_id, occurred_start DESC);

-- One entry per episode, and the episode is identified by where it sits. This
-- is what makes a re-ingest of the same range an UPDATE rather than a second
-- entry saying the same thing — the forget path re-retains under the same
-- document id and must land on the same row here (§14.4).
CREATE UNIQUE INDEX room_timeline_episode ON room_timeline_entries (chat_id, ord_start, ord_end);
