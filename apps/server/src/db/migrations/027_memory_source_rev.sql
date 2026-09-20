-- How memory knows a conversation changed under it (docs/MEMORY.md §8.1).
--
-- THE TOMBSTONE PROBLEM. `messages.deleted` is a tombstone: the row stays and
-- keeps its ordinal. So a sweep that looks for "documents covering a deleted
-- message" finds the same documents on every tick, forever, and re-retains them
-- forever — a loop that costs money and never finishes.
--
-- The discriminator is `messages.rev`. `appendEvent` sets it on every message an
-- event touches (`sync/events.ts`, the version rule) from the chat's monotonic
-- counter, so ANY change to what a message looks like — deleted, edited, its
-- audience narrowed — raises the highest revision inside a document's ordinal
-- range. Recording that high-water mark at retain time turns "has this changed"
-- into an integer comparison, and turns the rebuild into something that
-- converges: once rebuilt, the marks match and the document is left alone.
--
-- It also covers edits, which a deleted-flag check never could.
ALTER TABLE memory_documents ADD COLUMN source_rev_max INTEGER NOT NULL DEFAULT 0;

-- Backfill from what is actually there, rather than leaving zeroes behind: a
-- zero would read as "everything is stale" and rebuild every existing document
-- once for no reason.
UPDATE memory_documents d
   SET source_rev_max = COALESCE((
         SELECT MAX(m.rev) FROM messages m
          WHERE m.chat_id = d.chat_id
            AND m.ord BETWEEN d.ord_start AND d.ord_end), 0);
