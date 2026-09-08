-- Phase 1 identity: the authoritative records behind the local replica.
-- Client-side SQLite mirrors a subset of this (apps/desktop migration v2).

CREATE TABLE organizations (
  id              TEXT PRIMARY KEY,          -- our id, ULID
  workos_org_id   TEXT UNIQUE NOT NULL,      -- WorkOS Organization
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

-- Humans and agents. Phase 1 writes only type='human' /
-- identity_kind='workos_user', but the shape is what lets agents arrive in
-- Phase 6 without a migration (PHASE-1-IDENTITY.md §5, §12).
--
-- No email column, deliberately: email lives in WorkOS, is not stable, and is
-- never a join key. Agents have none at all.
CREATE TABLE actors (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id)    ON DELETE CASCADE,
  type            TEXT NOT NULL,
  handle          TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  avatar_url      TEXT,

  -- The ONLY place an identity reference may appear. Polymorphic so agents do
  -- not need a second nullable column (§5).
  identity_kind   TEXT,
  identity_id     TEXT,

  owner_actor_id  TEXT REFERENCES actors(id) ON DELETE SET NULL,
  provisioned_by  TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT actor_type   CHECK (type IN ('human','agent')),
  CONSTRAINT actor_prov   CHECK (provisioned_by IN ('self_signup','invite','sso_jit','scim','api')),
  CONSTRAINT actor_state  CHECK (state IN ('invited','active','suspended','deactivated')),
  CONSTRAINT actor_ikind  CHECK (identity_kind IS NULL OR identity_kind IN ('workos_user','workos_agent','system')),
  -- An agent records who operates it; a human must not.
  CONSTRAINT actor_owner  CHECK (CASE WHEN type = 'agent' THEN owner_actor_id IS NOT NULL
                                                          ELSE owner_actor_id IS NULL END)
);

-- One handle namespace across humans AND agents: this index is what stops
-- @harsh and @deploy-bot colliding regardless of type (§10).
CREATE UNIQUE INDEX actor_handle   ON actors (workspace_id, lower(handle));
-- One actor per identity per workspace.
CREATE UNIQUE INDEX actor_identity ON actors (workspace_id, identity_kind, identity_id)
  WHERE identity_id IS NOT NULL;

-- Sessions are OURS, not WorkOS's. The socket authenticates against this, so
-- steady-state sync does not depend on WorkOS being reachable.
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  -- Which install. A WorkOS token says who you are, never which device, and
  -- device_id scopes outbox dedupe and multi-device read state.
  device_id     TEXT NOT NULL,
  -- SHA-256 of the refresh token. Never the token itself: a database leak must
  -- not hand over live credentials.
  refresh_hash  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX session_actor  ON sessions (actor_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX session_refresh ON sessions (refresh_hash);
