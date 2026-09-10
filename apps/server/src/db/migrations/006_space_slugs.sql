-- Slugs belong to every NAMED space, not only to channels.
--
-- 005 called the column "channels only", following DESIGN.md §8.3. That was too
-- narrow: a room is named, addressable and worth linking to for exactly the
-- reasons a channel is, and nothing about the column resists it. Rooms may
-- carry a slug.
--
-- The two share ONE namespace per workspace, which the existing partial unique
-- index already gives us: `space_slug` on (workspace_id, slug) WHERE slug IS
-- NOT NULL. That is correct rather than incidental — a slug is how a space is
-- named in a URL or a mention, and two spaces answering to the same name would
-- be ambiguous whichever kinds they were.
--
-- What a slug is NOT for is a space with no name. DMs and group DMs derive
-- their name from their members and have nowhere to put one, so a slug on one
-- is meaningless — and meaningless is the state this table's constraints exist
-- to make unreachable.

ALTER TABLE spaces ADD CONSTRAINT space_slug_named
  CHECK (kind NOT IN ('dm', 'group_dm') OR slug IS NULL);

COMMENT ON COLUMN spaces.slug IS
  'URL/mention name, unique per workspace. Named kinds only: channel and room.';
