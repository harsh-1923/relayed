-- Whose request a space was created for (docs/WORKSPACE-AGENTS.md, create_room).
--
-- `created_by_actor_id` is the actor that performed the creation — an agent,
-- when a person asked one to make a room — and this is the person whose
-- authority it spent. NULL for a space a person created themselves, which is
-- every space before this. The same pair `panels` and `messages` carry, for
-- drawing "created by @triage for Alice". Neither grants anything.
ALTER TABLE spaces ADD COLUMN on_behalf_of_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL;
