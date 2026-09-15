-- Connections, through Composio (docs/WORKSPACE-AGENTS.md §6), and the
-- catalogue of what a connection may be for (§6.6).

-- ─── The catalogue: deployment-wide, not per workspace ──────────────────────
--
-- WHICH TOOLKITS APPEAR IS OUR DECISION, not Composio's: `enabled` starts
-- false, and stays false until an auth config exists and its tools have been
-- looked at (`enable-toolkit.ts`, D10). A daily refresh keeps both tables
-- current from Composio's own catalogue; nothing here is written by a person.
CREATE TABLE toolkits (
  slug              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL,
  logo_url          TEXT,
  categories        TEXT[] NOT NULL DEFAULT '{}',
  auth_scheme       TEXT NOT NULL,
  auth_config_id    TEXT NOT NULL,
  -- 'composio' in every environment until the first real person connects to
  -- this toolkit (§6.11); switching applies only to new connections.
  auth_managed_by   TEXT NOT NULL,
  auth_guide_url    TEXT,
  enabled           BOOLEAN NOT NULL DEFAULT false,
  deprecated        BOOLEAN NOT NULL DEFAULT false,
  refreshed_at      TIMESTAMPTZ NOT NULL,

  CONSTRAINT toolkit_auth_managed_by CHECK (auth_managed_by IN ('composio', 'relayed'))
);

-- Effect is DERIVED here, once, at refresh — never re-derived per read, and
-- never by the runtime, which only ever sees whatever `agent_tools.effect`
-- copied from this row at the moment a maintainer added the tool (§4.3).
CREATE TABLE toolkit_tools (
  toolkit           TEXT NOT NULL REFERENCES toolkits(slug) ON DELETE CASCADE,
  slug              TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL,
  hints             TEXT[] NOT NULL DEFAULT '{}',
  effect_derived    TEXT NOT NULL,
  -- Set by us, by hand, the one time the hint is wrong. NULL defers to it.
  effect_override   TEXT,
  important         BOOLEAN NOT NULL DEFAULT false,
  deprecated        BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (toolkit, slug),

  CONSTRAINT toolkit_tool_effect_derived  CHECK (effect_derived  IN ('read', 'write', 'destructive')),
  CONSTRAINT toolkit_tool_effect_override CHECK (effect_override IS NULL OR effect_override IN ('read', 'write', 'destructive'))
);

-- ─── Our mirror of a person's connected accounts (§6.3) ─────────────────────
--
-- A MIRROR, NEVER A SECOND AUTHORITY: Composio decides whether a call
-- succeeds, and when the two disagree the mirror is corrected, never the
-- other way (§6.9). Kept anyway because the connector store must render
-- offline, the broker's per-call check must be local, Composio no longer
-- says whose account it is, and the audit trail needs an id that survives a
-- reconnect replacing the Composio one underneath it.
CREATE TABLE connections (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id              TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  toolkit               TEXT NOT NULL,
  -- Replaced on reconnect — UNIQUE, not a primary key, so the row's own id
  -- (what the audit trail references) never changes underneath it.
  composio_account_id   TEXT UNIQUE,
  status                TEXT NOT NULL,
  -- Closed set. NULL unless status names why: expired | revoked_upstream |
  -- scopes_changed | failed.
  status_reason         TEXT,
  -- "Acme · harsh@acme.com", when the toolkit has a read tool that says who is
  -- signed in (§7.3); otherwise the toolkit's own name.
  label                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  connected_at          TIMESTAMPTZ,
  last_used_at          TIMESTAMPTZ,
  disconnected_at       TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT connection_status CHECK (status IN
    ('connecting', 'active', 'needs_reauth', 'failed', 'disconnected')),
  CONSTRAINT connection_status_reason CHECK (status_reason IS NULL OR status_reason IN
    ('expired', 'revoked_upstream', 'scopes_changed', 'failed'))
);

-- One LIVE connection per person per toolkit. Several accounts per toolkit is
-- deferred (§13) — a disconnected or failed row does not block a new attempt.
CREATE UNIQUE INDEX connection_live ON connections (actor_id, toolkit)
  WHERE status IN ('connecting', 'active', 'needs_reauth');

CREATE INDEX connection_actor ON connections (actor_id);

-- ─── One connect attempt, from the loopback listener to completion (§6.5) ───
--
-- The start token is stored HASHED, like a refresh token — the value that
-- crosses the wire (in `start_url`) must not be recoverable from a stolen
-- database row, and a token is spent exactly once (`consumed_at`).
CREATE TABLE connection_attempts (
  id                  TEXT PRIMARY KEY,
  connection_id       TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  actor_id            TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  start_token_hash    TEXT NOT NULL,
  -- Composio's `link()` response (§6.5), good for 10 minutes — the same
  -- window as this attempt. `/connections/start` 302s here once the one-time
  -- token is spent; nothing else can reconstruct this URL from Composio's API.
  redirect_url        TEXT NOT NULL,
  -- The loopback listener's ephemeral port, and the `state` it must see back —
  -- fixation's defence (§6.5): a start link approved by someone else lands on
  -- a port holding a DIFFERENT state, and nothing completes.
  port                INTEGER NOT NULL,
  state               TEXT NOT NULL,
  -- Set when this attempt exists to resolve a card (§5.5, §7.4) rather than a
  -- plain visit to the connector store.
  access_request_id    TEXT,
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ
);

CREATE INDEX connection_attempt_connection ON connection_attempts (connection_id);
-- The reconciler's sweep: attempts still open past their expiry (§6.9).
CREATE INDEX connection_attempt_open ON connection_attempts (expires_at) WHERE consumed_at IS NULL;

-- ─── Which agents may spend which of a person's connections (§6.4) ──────────
--
-- KEPT APART FROM `connections` ON PURPOSE. A connection says Alice has a
-- Linear account; this says which agent she has let use it, and at what
-- effect. Composio has no notion of an agent, so nothing here rides through
-- it — only this table stands between an agent Alice never allowed and her
-- Linear (invariant 82).
CREATE TABLE agent_permissions (
  invoker_actor_id  TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  agent_actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  toolkit           TEXT NOT NULL,
  -- The highest effect allowed: read < write < destructive.
  effect            TEXT NOT NULL,
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A row is REVOKED, never deleted: disconnecting the connection is what
  -- removes it for every agent at once (§6.4's table); revoking removes it
  -- for one. Both leave a record of what used to be true.
  revoked_at        TIMESTAMPTZ,
  PRIMARY KEY (invoker_actor_id, agent_actor_id, toolkit),

  CONSTRAINT agent_permission_effect CHECK (effect IN ('read', 'write', 'destructive'))
);

CREATE INDEX agent_permission_invoker ON agent_permissions (invoker_actor_id) WHERE revoked_at IS NULL;

-- ─── Webhook idempotency (D8) ────────────────────────────────────────────────
--
-- A TABLE, not Redis: there is no cache on the write path this belongs to,
-- and the dedupe must survive a restart the same way the event it is
-- deduping did. Swept after 24 hours by the reconciler (§6.9).
CREATE TABLE composio_webhook_deliveries (
  webhook_id    TEXT PRIMARY KEY,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
