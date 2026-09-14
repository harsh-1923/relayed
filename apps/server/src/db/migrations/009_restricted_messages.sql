-- Messages only some people can see (docs/WORKSPACE-AGENTS.md §8).
--
-- A DORMANT CAPABILITY: nothing in v1 writes one. It was built for agent
-- runs' access cards, which then became public messages only their actor can
-- act on (WORKSPACE-AGENTS.md §7.4, §8.1), and is kept, tested, for a later
-- private message that has to persist in a chat. The design question was never the
-- column; it was what an unlisted reader receives instead, and the answer is
-- the REVISION WITHOUT THE CONTENT (§8.3, §8.4): a cursor that simply skipped
-- the event would never become contiguous, and the chat would stop updating for
-- everyone the message was hidden from.

-- ─── Who may see a message ──────────────────────────────────────────────────
--
-- One nullable array on the row. NULL is everyone who can read the chat; a
-- list is only those actors. An EMPTY list is refused, never read as anyone:
-- code that narrows a list — "keep the listed actors still in the room" — would
-- otherwise produce `{}`, and whichever of "everyone" or "nobody" `{}` meant,
-- one of them is a bug nobody sees. Refused, it is an error somebody does.
--
-- `cardinality`, NOT `array_length`: `array_length('{}', 1)` is NULL, a CHECK
-- rejects only FALSE, and so `CHECK (array_length(visible_to, 1) >= 1)` PERMITS
-- the very row it looks like it forbids. The same shape as the `FALSE OR NULL`
-- trap AGENTS.md records, and tested per branch in restricted-schema.test.ts.
--
-- An array and not a table of (message_id, actor_id) tuples, which an earlier
-- draft proposed. The audience is fixed when the message is written and never
-- changes, is a handful of ids, and is only ever read beside the row it belongs
-- to — so a table bought nothing and cost a correlated subquery on every read
-- path. It is also not a grant anyone administers, which is why it is not a
-- membership row (the exception is recorded against AUTHZ.md invariant 53). If
-- an audience ever becomes editable after the fact, that decision reopens.
--
-- No default and no discriminator: NULL is a legitimate meaning here. What
-- stops a writer forgetting is the one function allowed to insert a message
-- (`writeMessage`), whose audience argument is required by its type.
ALTER TABLE messages ADD COLUMN visible_to TEXT[];
ALTER TABLE messages ADD CONSTRAINT message_visible_to
  CHECK (visible_to IS NULL OR cardinality(visible_to) >= 1);

-- ─── The log carries the list too ───────────────────────────────────────────
--
-- Catch-up reads `sync_events`, not `messages`, and has to redact per
-- requester — so the list is copied onto the log row when it is written.
--
-- Not a second permission store. A log row records what each recipient was
-- entitled to receive when it was written and never changes, and a message's
-- audience is immutable in v1, so the copy cannot drift. Widening one later
-- ("share with the chat") would be a new event, and the old row correctly stays
-- withheld for the history it describes.
ALTER TABLE sync_events ADD COLUMN visible_to TEXT[];
ALTER TABLE sync_events ADD CONSTRAINT sync_event_visible_to
  CHECK (visible_to IS NULL OR cardinality(visible_to) >= 1);
