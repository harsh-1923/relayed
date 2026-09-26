-- Organizations above workspaces, and company domains (docs/ORG-DOMAINS.md §12).
--
-- An org may now hold several workspaces. One of them is its DEFAULT: where a
-- domain join lands, and whose owner and admins are the org's admins (§6) —
-- derived, so there is no role table here. Org membership stays where it
-- already was, in workos_memberships.

-- Approval is shared: any number of orgs may approve the same domain, and
-- sign-in lists every one (§4.4). Verification is exclusive, and is the
-- enterprise tier (§11) — its two columns ship unused so that tier adds no
-- migration to this table.
CREATE TABLE organization_domains (
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain          TEXT NOT NULL,
  -- identity_id of the approving admin. An identity, not an actor: org admin
  -- is a property of the person, and actors are per workspace.
  approved_by     TEXT NOT NULL,
  approved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at     TIMESTAMPTZ,
  locks_creation  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, domain),
  -- Stored lower-cased and bare. A CHECK rather than a trigger: the one writer
  -- normalises, and this catches the day a second writer forgets to.
  CONSTRAINT organization_domain_shape CHECK (domain = lower(domain) AND domain LIKE '%_._%'
                                              AND domain NOT LIKE '%@%')
);
-- The sign-in lookup: every org on a domain.
CREATE INDEX organization_domains_domain ON organization_domains (domain);
CREATE UNIQUE INDEX organization_domains_verified ON organization_domains (domain)
  WHERE verified_at IS NOT NULL;

-- Which workspace a WorkOS invitation was sent from (§5.2). WorkOS invitations
-- are addressed to an ORGANIZATION; with several workspaces per org nothing
-- else records which one the person was asked into.
CREATE TABLE workspace_invitations (
  workos_invitation_id  TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invited_by_actor_id   TEXT REFERENCES actors(id) ON DELETE SET NULL,
  -- Filled from WorkOS's `accepted_user_id` the first time a live check sees
  -- the invitation accepted, so later checks need not ask WorkOS again.
  accepted_user_id      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workspace_invitations_accepted ON workspace_invitations (accepted_user_id)
  WHERE accepted_user_id IS NOT NULL;

-- invite_only by DEFAULT, so a workspace created by any path that forgets to
-- choose is closed rather than open.
ALTER TABLE workspaces ADD COLUMN join_policy TEXT NOT NULL DEFAULT 'invite_only';
ALTER TABLE workspaces ADD CONSTRAINT workspace_join_policy
  CHECK (join_policy IN ('org_open','invite_only'));

ALTER TABLE organizations ADD COLUMN default_workspace_id TEXT
  REFERENCES workspaces(id) ON DELETE SET NULL;

-- 'domain' is new. 'system' has been here since 022_system_agents.sql and
-- every workspace has rows carrying it.
ALTER TABLE actors DROP CONSTRAINT actor_prov;
ALTER TABLE actors ADD  CONSTRAINT actor_prov
  CHECK (provisioned_by IN ('self_signup','invite','domain','sso_jit','scim','api','system'));

-- Backfill. Until now every org held exactly one workspace, so it is the
-- default, its owner is thereby the org's admin, and opening it to the org
-- changes nothing for anyone until a domain is approved (§16 question 5).
-- The oldest wins should an org somehow hold two.
UPDATE organizations o SET default_workspace_id = (
  SELECT w.id FROM workspaces w WHERE w.org_id = o.id
   ORDER BY w.created_at, w.id LIMIT 1);
UPDATE workspaces w SET join_policy = 'org_open'
  FROM organizations o WHERE o.default_workspace_id = w.id;
