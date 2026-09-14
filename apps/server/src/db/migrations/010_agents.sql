-- Workspace agents: the definition beside the actor (docs/WORKSPACE-AGENTS.md §4).
--
-- An agent IS an actor — `type = 'agent'`, `identity_kind = 'system'`, owned by
-- its creator — and every column that needs already exists in 001_identity.sql,
-- which was shaped for it. What an actor row cannot hold is what the agent was
-- told and what it may use; that is this migration.

CREATE TABLE agents (
  actor_id        TEXT PRIMARY KEY REFERENCES actors(id) ON DELETE CASCADE,
  -- Denormalised from the actor, for the directory page's join and for a
  -- workspace-scoped sweep, neither of which should go through `actors` to ask.
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- One line: shown in mention autocomplete, on the profile and on access cards.
  -- It is how an invoker decides whether to trust the agent.
  description     TEXT NOT NULL DEFAULT '',
  -- The system prompt, as Markdown. Readable by every member of the workspace
  -- (§4.1): an agent spends each invoker's authority, so nobody spending it may
  -- be kept from what it was told.
  instructions    TEXT NOT NULL,
  -- A key in the runtime's provider table (AGENT-RUNTIME.md §4). NULL is the
  -- runtime's fallback, which is a choice, not a missing value.
  model           TEXT,
  thinking_level  TEXT,
  -- Bumped on every change to instructions, model or tools. A run records the
  -- value it started with, so "what was it told when it did that" has an answer.
  config_rev      INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Bytes, not characters: the cap exists for the model's context and for a
  -- frame's size, and both are measured in bytes. 32 KB of emoji is not 32 KB.
  CONSTRAINT agent_instructions_size CHECK (octet_length(instructions) <= 32768),
  CONSTRAINT agent_description_size  CHECK (char_length(description) <= 200),
  CONSTRAINT agent_config_rev        CHECK (config_rev >= 1)
);

CREATE INDEX agent_workspace ON agents (workspace_id);

-- What an agent may call. Nothing writes it until the connector store exists
-- (the plan's step 4); the shape is fixed now because the directory summary
-- already aggregates it.
--
-- ONE ROW PER TOOL, NEVER A WILDCARD. "Everything in the GitHub toolkit" would
-- grow whenever Composio adds a tool, and an agent would gain a destructive
-- action nobody chose (§4.3).
CREATE TABLE agent_tools (
  agent_actor_id  TEXT NOT NULL REFERENCES agents(actor_id) ON DELETE CASCADE,
  toolkit         TEXT NOT NULL,           -- 'linear'
  tool            TEXT NOT NULL,           -- 'LINEAR_CREATE_LINEAR_ISSUE'
  effect          TEXT NOT NULL,           -- copied from the catalogue when added (§6.6)
  -- Reserved for the first guardrail (§13). v1 writes 'never', and a run whose
  -- snapshot holds anything else is refused until approvals exist.
  approval        TEXT NOT NULL DEFAULT 'never',
  PRIMARY KEY (agent_actor_id, tool),

  CONSTRAINT agent_tool_effect   CHECK (effect IN ('read', 'write', 'destructive')),
  CONSTRAINT agent_tool_approval CHECK (approval IN ('never', 'always'))
);

-- ─── Who may do what to an agent ────────────────────────────────────────────
--
-- As tuples, like every other permission (AUTHZ.md invariant 53): "the creator
-- may edit" is not `actor.id = agent.owner_actor_id`, it is
--
--   memberships(scope_type = 'agent', scope_id = <agent>, actor_id = <creator>, role = 'admin')
--
-- `membership_scope` widens to admit it, deliberately and here. `owner` stays
-- workspace-only (`membership_owner_scope` is untouched).
ALTER TABLE memberships DROP CONSTRAINT membership_scope;
ALTER TABLE memberships ADD CONSTRAINT membership_scope
  CHECK (scope_type IN ('workspace', 'space', 'chat', 'agent'));

-- An agent's rows are its maintainers, and a maintainer is an admin. A `member`
-- row on an agent would mean nothing `can()` evaluates — a grant that looks
-- like something and does nothing is refused rather than stored.
ALTER TABLE memberships ADD CONSTRAINT membership_agent_role
  CHECK (scope_type <> 'agent' OR role = 'admin');
