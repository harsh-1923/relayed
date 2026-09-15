-- One DM per set of people (DESIGN.md §7.1, opening a DM).
--
-- A DM and a group DM are identified by who is in them: opening a conversation
-- with Bob finds the one already there rather than making a second. `dm_key`
-- is the founding participants' actor ids, sorted and comma-joined — the
-- opener included — and the unique index is what makes two people opening the
-- same conversation at the same moment land in one, not two.
--
-- The FOUNDING set, not whoever is a member now. A DM is `sealed`: nobody is
-- added to one, so the set cannot grow, and someone who left is brought back
-- by opening the conversation again rather than creating a new one.
--
-- Nullable: every other kind has none, and so do the DM rows written before
-- this, which were test leftovers with no members.
ALTER TABLE spaces ADD COLUMN dm_key TEXT;
ALTER TABLE spaces ADD CONSTRAINT space_dm_key
  CHECK (dm_key IS NULL OR kind IN ('dm', 'group_dm'));
CREATE UNIQUE INDEX space_dm_members ON spaces(workspace_id, dm_key) WHERE dm_key IS NOT NULL;
