-- The broker (docs/WORKSPACE-AGENTS.md §5.5), executing through a Composio
-- session (§6.7), and the access card a missing connection or permission
-- raises (§7.4).

-- ─── The audit trail, and the only table that tells the truth (§5.5) ────────
--
-- Claimed BEFORE permission or connection is checked, so a call that stopped
-- there is in the trail too — `outcome` moves from 'pending' to its final
-- value in the same row, never a second insert. Results are never stored:
-- they are the third party's data, and the run's own reply already carries
-- what the agent chose to say.
CREATE TABLE agent_tool_calls (
  run_id          TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_call_id    TEXT NOT NULL,
  toolkit         TEXT NOT NULL,
  tool            TEXT NOT NULL,
  effect          TEXT NOT NULL,
  connection_id   TEXT REFERENCES connections(id),
  outcome         TEXT NOT NULL,
  error_code      TEXT,
  -- Truncated to 8 KB before this is written (checkpoints.ts) — an argument
  -- blob is not worth losing the row that describes it.
  arguments       JSONB,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, tool_call_id),

  CONSTRAINT agent_tool_call_effect CHECK (effect IN ('read', 'write', 'destructive')),
  -- NOT run_not_running/invoker_inactive/agent_inactive/tool_not_allowed: a
  -- call refused at steps 1-5 never reaches step 6, so no row is ever claimed
  -- for it to become one of those outcomes (§5.5's own ordering).
  CONSTRAINT agent_tool_call_outcome CHECK (outcome IN (
    'pending', 'ok', 'duplicate_call', 'permission_required', 'connection_required',
    'needs_reauth', 'failed', 'refused', 'tool_deprecated', 'rate_limited',
    'provider_forbidden', 'provider_unavailable'))
);

-- ─── The card in a chat (§7.4) ───────────────────────────────────────────────
--
-- One per toolkit per run. `access.ts` is not built yet (this table is schema
-- only, kept with its siblings per this step's migration): nothing writes to
-- it until then.
CREATE TABLE access_requests (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  actor_id        TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  agent_actor_id  TEXT NOT NULL REFERENCES actors(id),
  toolkit         TEXT NOT NULL,
  effect          TEXT NOT NULL,
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  expired_at      TIMESTAMPTZ,

  UNIQUE (run_id, toolkit),
  CONSTRAINT access_request_effect CHECK (effect IN ('read', 'write', 'destructive'))
);

-- ─── The Composio session behind (agent, invoker, config_rev) (§6.7) ────────
--
-- Replaced by 016_tool_discovery.sql: one session per person, and the spike
-- in spikes/composio-discovery/ found pinning is not required to execute
-- (it is kept, for the audit — see sessions.ts). The comment below is the
-- reasoning this table was created with.
--
-- `connected_accounts` is the pin this row was created with — toolkit ->
-- composio_account_id. NOT redundant with `connections`: a live-verified
-- correction to §6.7's assumption (checked 2026-09-14 against the real v3.1
-- tool_router API) is that a session does NOT resolve "the invoker's active
-- account" on its own — execution 400s `ToolRouterV2_NoActiveConnection` for
-- a genuinely ACTIVE account unless `connected_accounts` names it explicitly
-- at creation. Kept here so a reconnect (a new composio_account_id) is
-- detected before the next call and the session recreated, rather than
-- silently executing against an account that no longer matches.
CREATE TABLE composio_sessions (
  agent_actor_id      TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  invoker_actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  config_rev          INTEGER NOT NULL,
  session_id          TEXT NOT NULL,
  connected_accounts  JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (agent_actor_id, invoker_actor_id, config_rev)
);
