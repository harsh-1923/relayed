-- The migration docs/ORG-DOMAINS.md §12 proposes, as written there.
--
-- Kept in the spike rather than apps/server/src/db/migrations: a running
-- `pnpm dev` applies anything saved in that folder to the dev database at once.
-- run.ts applies this file to its own throwaway database only.
--
-- org_roles is here only so checks 5.2–5.4 can compare it against the derived
-- rule; the doc drops it (§6). workspace_invitations is not here: it came out of
-- this spike's findings (§5.2) and has not been run.

CREATE TABLE organization_domains (
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain          TEXT NOT NULL,
  approved_by     TEXT NOT NULL,
  approved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at     TIMESTAMPTZ,
  locks_creation  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, domain)
);
CREATE INDEX organization_domains_domain ON organization_domains (domain);
CREATE UNIQUE INDEX organization_domains_verified ON organization_domains (domain)
  WHERE verified_at IS NOT NULL;

ALTER TABLE workspaces ADD COLUMN join_policy TEXT NOT NULL DEFAULT 'invite_only'
  CHECK (join_policy IN ('org_open','invite_only'));
ALTER TABLE organizations ADD COLUMN default_workspace_id TEXT REFERENCES workspaces(id);

CREATE TABLE org_roles (
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  identity_kind  TEXT NOT NULL,
  identity_id    TEXT NOT NULL,
  role           TEXT NOT NULL,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at        TIMESTAMPTZ,
  PRIMARY KEY (org_id, identity_kind, identity_id),
  CONSTRAINT org_role CHECK (role IN ('admin','member'))
);

ALTER TABLE actors DROP CONSTRAINT actor_prov;
ALTER TABLE actors ADD CONSTRAINT actor_prov
  CHECK (provisioned_by IN ('self_signup','invite','domain','sso_jit','scim','api','system'));

-- Backfill (§12): each existing org has exactly one workspace.
UPDATE organizations o SET default_workspace_id = w.id
  FROM workspaces w WHERE w.org_id = o.id;
UPDATE workspaces SET join_policy = 'org_open';

INSERT INTO org_roles (org_id, identity_kind, identity_id, role)
SELECT DISTINCT ON (a.org_id, a.identity_id)
       a.org_id, a.identity_kind, a.identity_id,
       CASE WHEN m.role = 'owner' THEN 'admin' ELSE 'member' END
  FROM actors a
  JOIN memberships m ON m.actor_id = a.id AND m.scope_type = 'workspace'
                    AND m.scope_id = a.workspace_id AND m.left_at IS NULL
 WHERE a.type = 'human' AND a.identity_kind = 'workos_user' AND a.state = 'active'
 ORDER BY a.org_id, a.identity_id, (m.role = 'owner') DESC;
