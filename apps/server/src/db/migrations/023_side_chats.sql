-- Side chats in synced rooms (docs/SIDE-CHATS.md).
--
-- A side chat opens with a system row naming who it was started with. The
-- subject is whoever started it; the people named are in the body, as
-- references (`actor-ref:`), so the row notifies nobody.
ALTER TABLE messages DROP CONSTRAINT message_kind_shape;
ALTER TABLE messages ADD CONSTRAINT message_kind_shape CHECK (
  (message_kind = 'actor' AND system_kind IS NULL AND subject_actor_id IS NULL)
  OR
  (message_kind = 'system' AND system_kind IN ('space.member_added', 'chat.started')
    AND subject_actor_id IS NOT NULL)
);
