-- Space membership markers (docs/SPACE-MEMBERSHIP-MARKERS.md).
--
-- A system message is history the server wrote about a successful command, not
-- authored content. The discriminator is a real column, not an inferred body,
-- so unread queries and future edit/delete/reply/reaction refusals can be
-- `WHERE message_kind = 'actor'` rather than a text match.

ALTER TABLE messages ADD COLUMN message_kind TEXT NOT NULL DEFAULT 'actor';
ALTER TABLE messages ADD COLUMN system_kind TEXT;
ALTER TABLE messages ADD COLUMN subject_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT;

ALTER TABLE messages ADD CONSTRAINT message_kind_values CHECK (
  message_kind IN ('actor', 'system')
);

-- Written as two positive branches, never a NOT IN, so a NULL in either column
-- reads as a failing row rather than a passing one (the same NULL-trap shape
-- message_parts_shape and space_dm_sealed already guard against).
ALTER TABLE messages ADD CONSTRAINT message_kind_shape CHECK (
  (message_kind = 'actor' AND system_kind IS NULL AND subject_actor_id IS NULL)
  OR
  (message_kind = 'system' AND system_kind IN ('space.member_added')
    AND subject_actor_id IS NOT NULL)
);
