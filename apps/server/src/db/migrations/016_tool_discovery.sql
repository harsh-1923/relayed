-- Agents find their own tools (docs/WORKSPACE-AGENTS-IMPL.md, step 7).
--
-- Nobody picks an agent's tools any more (D21): a run searches the enabled
-- toolkits through `find_tools`, and the access card asks for access when it
-- does. The per-agent list goes, with no compatibility layer — nothing reads it.
DROP TABLE agent_tools;

-- One Composio session per PERSON, not per (agent, person, config_rev) (D24):
-- with no tool list, nothing about a session depends on the agent. The old
-- rows are per agent and cannot be converted; every person's next tool call
-- creates their one session.
DROP TABLE composio_sessions;

CREATE TABLE composio_sessions (
  invoker_actor_id    TEXT PRIMARY KEY REFERENCES actors(id) ON DELETE CASCADE,
  session_id          TEXT NOT NULL,
  -- The enabled toolkits the session was created for. `toolkits.enabled`
  -- changing means a different session policy, so it is recreated (sessions.ts).
  toolkits            TEXT[] NOT NULL,
  -- toolkit -> composio_account_id: what the session is pinned to now. Patched,
  -- not recreated, when the person connects or reconnects a toolkit.
  connected_accounts  JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
