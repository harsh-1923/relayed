-- What memory has ingested, and the handle that lets it be forgotten
-- (docs/MEMORY.md §8.3).
--
-- Hindsight returns metadata with a recalled fact but CANNOT BE ASKED "which
-- documents came from message X" — metadata is not a filter there. So the
-- mapping lives here, and it is what makes four separate jobs possible with one
-- table: forgetting a deleted message, dropping a deleted space, moving a
-- converted space's documents, and answering "how far has memory read" without
-- a network call.
--
-- Built in the first stage rather than as a follow-up, deliberately:
-- retrofitting deletion into a memory system is how a compliance problem gets
-- discovered instead of designed.
CREATE TABLE memory_documents (
  -- The Hindsight bank. Not a foreign key to anything — it is derived
  -- (`memory/banks.ts`), and a bank is a thing on someone else's server.
  bank_id      TEXT NOT NULL,

  -- The id WE CHOSE and sent on retain: `<chat_id>:<ord_start>-<ord_end>`.
  -- Choosing it is what makes deletion a single cascading call. xyne-spaces
  -- could not delete by id because their retain ran `async: true` and returned
  -- none, leaving them to work around it with tags.
  document_id  TEXT NOT NULL,

  -- Kept even though the bank id already implies a scope: an admin view counts
  -- by workspace, and a space deletion sweeps by space, and neither should have
  -- to parse a bank id to do it.
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id     TEXT NOT NULL REFERENCES spaces(id)     ON DELETE CASCADE,
  chat_id      TEXT NOT NULL REFERENCES chats(id)      ON DELETE CASCADE,

  -- The episode's span, by ordinal. Ordinals are per chat and never renumbered
  -- (DESIGN.md §8.1), so this is a stable address for "the messages this came
  -- from" in a way no timestamp would be.
  ord_start    INTEGER NOT NULL,
  ord_end      INTEGER NOT NULL,

  retained_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (bank_id, document_id),
  CONSTRAINT memory_document_span CHECK (ord_end >= ord_start)
);

-- The forget path's only query: "which documents cover this message?" A deleted
-- message arrives as (chat_id, ord), and this is what turns that into the set of
-- documents to delete and re-retain.
CREATE INDEX memory_documents_span ON memory_documents (chat_id, ord_start, ord_end);

-- Sweeping a space when it is deleted, converted, or audited.
CREATE INDEX memory_documents_space ON memory_documents (space_id);

-- How far memory has read in a chat. Separate from `documents.covered_through`
-- on purpose: that one is the room summary's watermark and moves for its own
-- reasons, and two jobs sharing one watermark is two jobs that can starve each
-- other.
CREATE TABLE memory_watermarks (
  chat_id      TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  space_id     TEXT NOT NULL REFERENCES spaces(id)   ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Every message at or below this ordinal has been ingested OR deliberately
  -- skipped by the gate. It advances on a skip too — an episode with no facts
  -- in it is still an episode that has been read.
  ingested_through_ord INTEGER NOT NULL DEFAULT 0,

  -- The claim, the shape `documents.refresh_lease_until` already uses: a lease
  -- in the past means the server holding it is gone, not that work is running.
  lease_until  TIMESTAMPTZ,
  failures     INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX memory_watermarks_space ON memory_watermarks (space_id);
