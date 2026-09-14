-- A message's parts (docs/AGENT-RESPONSES.md, the message contract §3).
--
-- An agent's reply is an ordered list of parts — Markdown, tools that really
-- ran, UI blocks — and `body` is DERIVED from them by the server, never written
-- by a model. Local rooms have stored parts since they were built; this puts
-- them on the synced path, so a reply in a channel can carry the same.
--
-- NULL is a message with no parts: every message a person has ever sent, and
-- what `body` alone renders. JSONB rather than TEXT, because the server reads
-- parts back when it derives, validates and updates, and a column the database
-- cannot see into would let a string that is not JSON be stored as one.

ALTER TABLE messages ADD COLUMN parts JSONB;

-- NULL, or a non-empty array. An empty array is refused rather than stored:
-- "has parts, and there are none" is a third state `body` alone already says.
--
-- A CASE, not `jsonb_typeof(parts) = 'array' AND jsonb_array_length(parts) >= 1`:
-- Postgres does not promise to evaluate an AND left to right, and
-- `jsonb_array_length` RAISES on a scalar rather than returning false. A CASE
-- is the one form whose order is guaranteed.
ALTER TABLE messages ADD CONSTRAINT message_parts_shape CHECK (
  CASE
    WHEN parts IS NULL THEN true
    WHEN jsonb_typeof(parts) <> 'array' THEN false
    ELSE jsonb_array_length(parts) >= 1
  END
);

-- A backstop, not the limit. The writer refuses parts over 256 KB as the
-- client serialises them (`PART_LIMITS` in @relayed/protocol); Postgres's text
-- form of the same JSON is a little longer, so this sits at twice that, where
-- only a writer that skipped the check can reach.
ALTER TABLE messages ADD CONSTRAINT message_parts_size CHECK (
  parts IS NULL OR octet_length(parts::text) <= 524288
);
