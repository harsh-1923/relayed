-- Images for organizations and workspaces (STORAGE.md §14).
--
-- Actors already carry avatar_url from their WorkOS profile. These are the
-- other two subjects a client renders: the workspace in the switcher rail, and
-- the org above it.
--
-- Read path only for now. How an image gets SET — upload, or a URL, or
-- inheriting a WorkOS organization's — is deliberately undecided; the column is
-- what lets the client render one the moment it exists, without a migration
-- landing on every installed client at the same time.

ALTER TABLE organizations ADD COLUMN avatar_url TEXT;

-- A workspace with no image of its own shows its organization's. v1 ships one
-- workspace per org (§6.1), so in practice they are the same picture — but the
-- columns are separate because the layer that owns the brand is the org, and
-- the layer a member actually looks at is the workspace.
ALTER TABLE workspaces    ADD COLUMN avatar_url TEXT;
