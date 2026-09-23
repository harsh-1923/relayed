-- Ambient answers (docs/AMBIENT-RESPONSES.md, the table §9.1): one row for every
-- time a chat was looked at, whatever came of it.
--
-- SERVER-ONLY, NEVER SYNCED. What an agent considered saying and did not is not
-- part of any chat's history; it is the record the thresholds are tuned against
-- and the answer to "why did it (not) speak?".
--
-- THE WATERMARK IS NOT A COLUMN. How far a chat has been judged is the largest
-- `through_ord` here — the room summariser's reasoning (DOCUMENTS.md §4.4): the
-- number the decision needs is already stored, and a cursor beside it would be a
-- second copy able to disagree.
CREATE TABLE ambient_decisions (
  id                 TEXT PRIMARY KEY,                                    -- amb_…
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id            TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  -- `ambient` after a lull; `follow_up` straight after an agent spoke (§4).
  kind               TEXT NOT NULL,
  -- The window judged, as ordinals in `chat_id`.
  from_ord           BIGINT NOT NULL,
  through_ord        BIGINT NOT NULL,
  -- The message the answer is about, once gate 1 has pointed at one.
  trigger_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  -- The agent chosen, if any.
  agent_actor_id     TEXT REFERENCES actors(id) ON DELETE SET NULL,
  -- The versioned model id that answered. NULL when no gate answered at all.
  model              TEXT,
  -- Every probability, exactly as returned — what tuning reads (§10.1).
  gate1              JSONB,
  gate2              JSONB,
  -- Why it ended as it did, from closed sets in `agents/ambient/` — never text a
  -- model or a person wrote.
  because            TEXT,
  -- The job's draft, kept only in shadow for a person to read (§16, question 4).
  draft              TEXT,
  reply_message_id   TEXT REFERENCES messages(id) ON DELETE SET NULL,
  outcome            TEXT NOT NULL DEFAULT 'pending',
  -- A claim. Past it, a `pending` row belongs to a server that is gone.
  lease_until        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ,

  CONSTRAINT ambient_kind CHECK (kind IN ('ambient', 'follow_up')),
  CONSTRAINT ambient_outcome CHECK (outcome IN
    ('pending', 'silent', 'declined', 'suppressed', 'gate_error', 'failed',
     'withdrawn', 'stale', 'shadow', 'posted')),
  CONSTRAINT ambient_window CHECK (from_ord <= through_ord),
  -- Two passes over the same window cannot both act: the second insert fails.
  CONSTRAINT ambient_once UNIQUE (chat_id, kind, through_ord)
);

-- The watermark: the largest `through_ord` per chat.
CREATE INDEX ambient_chat ON ambient_decisions (chat_id, through_ord DESC);
-- "Not helpful here" finds its decision by the message it posted.
CREATE INDEX ambient_reply ON ambient_decisions (reply_message_id) WHERE reply_message_id IS NOT NULL;
