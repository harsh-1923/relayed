-- Documents, and a room's running summary (docs/DOCUMENTS.md §3).
--
-- A document is text that BELONGS to a space and changes over time — as opposed
-- to a message, which is an event that happened. The first kind is the summary
-- every room keeps; `note` is reserved now because a CHECK cannot be altered on
-- the replica's SQLite, and a rebuild there is the cost of saving three
-- characters here (`workspace.ts` version 6 is the cautionary example).
CREATE TABLE documents (
  -- doc_…, a ULID.
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id            TEXT NOT NULL REFERENCES spaces(id)     ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  title               TEXT,

  -- The document itself. Markdown is canonical until a CRDT takes over (§3.4),
  -- and `format` is what makes that swap a value rather than a schema change.
  body                TEXT NOT NULL DEFAULT '',
  format              TEXT NOT NULL DEFAULT 'markdown',

  -- Monotonic per document: every write increments it, and every reader keeps
  -- the highest it has seen. That is what stops an event arriving late from
  -- winding a client back to an older body (§7.2).
  rev                 INTEGER NOT NULL DEFAULT 0,

  -- Who wrote the current revision — the Roomkeeping agent for a summary.
  -- Nullable only because an actor may be deleted and the document outlives it.
  updated_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,

  -- How far its writer had read: { "cht_…": 412, "cht_…": 88 }. Per chat and by
  -- ordinal, because ordinals are per chat and a wall clock across chats would
  -- skew. NULL for a document not derived from messages.
  covered_through     JSONB,

  -- The refresh lease, the shape `agent_runs` already uses: a job claims a
  -- document by setting this, and a lease in the past means the server that
  -- claimed it is gone, not that a refresh is still running. Nothing claims
  -- one until the summariser exists (§4.4).
  refresh_lease_until TIMESTAMPTZ,
  refresh_failures    INTEGER NOT NULL DEFAULT 0,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT document_kind   CHECK (kind IN ('room_summary', 'note')),
  CONSTRAINT document_format CHECK (format IN ('markdown')),
  CONSTRAINT document_rev    CHECK (rev >= 0)
);

-- A room has exactly one summary. The index is what makes that true, rather
-- than every writer remembering to look first.
CREATE UNIQUE INDEX document_room_summary ON documents (space_id) WHERE kind = 'room_summary';
CREATE INDEX document_space ON documents (space_id);

-- Every revision, as a full snapshot rather than a diff: a summary is
-- kilobytes, and a diff format would be a second thing to keep true for no gain
-- at that size. Retention is the last 50 per document, pruned by the writer
-- (§3.3).
CREATE TABLE document_revisions (
  document_id     TEXT    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  rev             INTEGER NOT NULL,
  body            TEXT    NOT NULL,
  author_actor_id TEXT    REFERENCES actors(id) ON DELETE SET NULL,
  covered_through JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (document_id, rev)
);

-- The panel a document is read in (§8.1). Structural for a room's summary:
-- created with the room, always in the tab strip, never removed.
ALTER TABLE panels DROP CONSTRAINT panel_type;
ALTER TABLE panels ADD  CONSTRAINT panel_type
  CHECK (type IN ('chat', 'web', 'diff', 'file', 'attachment', 'doc'));

-- One panel per document per room, for the same reason `panel_web_url` exists
-- for a page: opening the same document twice is one tab, not two.
CREATE UNIQUE INDEX panel_document ON panels (space_id, (payload->>'document_id'))
  WHERE type = 'doc' AND removed_at IS NULL;
