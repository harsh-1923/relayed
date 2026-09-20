-- What a person has asked to be remembered about them (docs/MEMORY.md §5.5).
--
-- WHY A TABLE AT ALL, when the notes themselves live in Hindsight: so we can
-- tell an EMPTY person bank from a full one without asking. Measured on
-- 2026-09-19, a recall against a bank that has never been written to takes
-- **7.5 seconds to return nothing** — more than twice the recall deadline. Two
-- of the three banks a DM run opens are usually in exactly that state, so every
-- run was paying seconds for silence and the deadline was biting the one bank
-- that had something to say.
--
-- NOT `memory_documents`, which requires a space and a chat: a person note is
-- not derived from messages. Nothing in the forget sweep should ever find one,
-- because no message deletion can invalidate it — the person is the only one
-- who can take it back.
CREATE TABLE memory_person_notes (
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  -- The id we chose on retain: `remember:<run id>`. One row per `remember`
  -- call, which is the unit a person performed and the only unit that cascades.
  document_id TEXT NOT NULL,
  /** The run it was asked for in, so a note can be traced back to the asking. */
  run_id      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, document_id)
);
