-- Files: every byte we hold, whatever it is for (docs/FILES.md).
--
-- Metadata only; the bytes are in the object store under their sha256. A file
-- carries NO permission of its own — who may read it is decided by whatever
-- references it (§6). The first references are organization and workspace
-- logos; message attachments follow.

CREATE TABLE files (
  id           TEXT PRIMARY KEY,
  -- Hex, and the object key. Bytes are shared across orgs; rows are not (§3).
  sha256       TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size         BIGINT NOT NULL CHECK (size > 0),
  -- As SNIFFED from the bytes at completion, never as the client declared.
  media_type   TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  -- Fixed at upload. It sets the limits a file was checked against and its
  -- read rule, so it can never change — a logo is public by id (§6.1), and an
  -- attachment must never become one.
  purpose      TEXT NOT NULL CHECK (purpose IN ('logo', 'attachment')),
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uploaded_by  TEXT REFERENCES actors(id) ON DELETE SET NULL,
  state        TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- "Does this org already have these bytes?" — the upload shortcut, scoped to
-- the org so it never reveals what another tenant holds (§3).
CREATE INDEX files_org_sha ON files (org_id, sha256) WHERE state = 'ready';
-- The pending sweep.
CREATE INDEX files_pending ON files (created_at) WHERE state = 'pending';

-- The first references. SET NULL, not CASCADE: a missing file is a missing
-- logo — initials, which is the ordinary state — not a missing org.
ALTER TABLE organizations ADD COLUMN logo_file_id TEXT REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE workspaces    ADD COLUMN logo_file_id TEXT REFERENCES files(id) ON DELETE SET NULL;
