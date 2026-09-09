-- Authorization (docs/AUTHZ.md).
--
-- A permission is a ROW here, never a column on the object and never a boolean
-- on an actor (§4). Read as a triple this is a relationship tuple —
-- (actor, role, scope_type:scope_id) — which is what lets the evaluator be
-- swapped for a relationship engine later without touching the data (§10).

CREATE TABLE memberships (
  -- Three levels, matching the containment in DESIGN.md §7.1 exactly. An
  -- authorization hierarchy that disagreed with the data hierarchy would need
  -- every rule spelled out twice.
  scope_type  TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,

  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Leaving is a tombstone, not a delete: the same discipline as deactivated
  -- actors (§6.3). "Was Alice ever in this room" stays answerable, and rejoining
  -- is an UPDATE rather than a row that has to be resurrected from nothing.
  left_at     TIMESTAMPTZ,

  PRIMARY KEY (scope_type, scope_id, actor_id),

  CONSTRAINT membership_scope CHECK (scope_type IN ('workspace','space','chat')),
  CONSTRAINT membership_role  CHECK (role IN ('owner','admin','member')),
  -- `owner` exists only at the workspace level (AUTHZ §6). A space owner would
  -- be a second, quieter admin with no defined difference.
  CONSTRAINT membership_owner_scope CHECK (role <> 'owner' OR scope_type = 'workspace')
);

-- Exactly one owner per workspace, enforced rather than remembered. Two owners
-- makes `transfer_ownership` ambiguous; zero makes a workspace unadministrable
-- the moment its founder is deprovisioned (AUTHZ §14 item 1).
CREATE UNIQUE INDEX membership_one_owner ON memberships (scope_type, scope_id)
  WHERE role = 'owner' AND left_at IS NULL;

-- The hot path: every check starts from "what does this actor belong to".
CREATE INDEX membership_actor ON memberships (actor_id) WHERE left_at IS NULL;
CREATE INDEX membership_scope ON memberships (scope_type, scope_id) WHERE left_at IS NULL;

-- Every actor that exists today founded its own workspace, so each becomes its
-- owner. Written as a backfill rather than left to the application: an actor
-- with no membership row can do nothing at all, which would lock every existing
-- account out of its own workspace the moment can() starts being consulted.
INSERT INTO memberships (scope_type, scope_id, actor_id, role, joined_at)
SELECT 'workspace', a.workspace_id, a.id, 'owner', a.created_at
FROM actors a
WHERE a.type = 'human' AND a.state <> 'deactivated';
