-- The handoff from a mention to a run (docs/WORKSPACE-AGENTS.md §5.2).
--
-- Inserted INSIDE the transaction that writes the triggering message, beside
-- its sync_events row — never in fanout, which runs after commit and is
-- allowed to miss. An agent has no catch-up; a mention lost between commit and
-- fanout is never answered (DESIGN.md §13.8).

CREATE TABLE agent_runs (
  id                  TEXT PRIMARY KEY,                -- run_…
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_actor_id      TEXT NOT NULL REFERENCES actors(id),
  invoker_actor_id    TEXT NOT NULL REFERENCES actors(id),
  chat_id             TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  trigger_message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attempt             INTEGER NOT NULL DEFAULT 1,
  state               TEXT NOT NULL DEFAULT 'queued',
  -- Why a CLAIMED run did not start — admitRun's refusal codes (§5.3). NULL
  -- until refused.
  refusal             TEXT,
  -- The definition this run used: instructions, model, tools, config_rev — a
  -- snapshot taken at claim time, so "what was it told when it did that" has
  -- an answer even after the agent is edited or deactivated.
  config              JSONB,
  -- Chosen BEFORE the reply is written, so a retry of the write (applyOnce)
  -- cannot post twice.
  reply_message_id    TEXT,
  -- A deferred run is not claimed again until this moment (admitRun, §5.9).
  not_before          TIMESTAMPTZ,
  -- Closed set: runtime_busy | invoker_busy | thread_busy (reserved).
  defer_reason        TEXT,
  stopped_by          TEXT REFERENCES actors(id),
  -- Set at claim to now() + the run timeout + slack. A sweep past this moment
  -- means the server that claimed it is gone, not that the run is still going.
  lease_until         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,

  CONSTRAINT run_state CHECK (state IN ('queued', 'running', 'completed', 'failed',
                                        'cancelled', 'timeout', 'refused', 'interrupted')),
  -- One row per (trigger, agent, attempt): a mention starts exactly one run per
  -- agent it names, and a replayed op reaching this insert regardless (it
  -- should not: applyOnce returns before it) would collide rather than double.
  UNIQUE (trigger_message_id, agent_actor_id, attempt)
);

-- The claim query's index: queued runs due now, oldest first, and nothing
-- else — `state = 'queued'` keeps it small forever rather than growing with
-- every run that ever finished.
CREATE INDEX run_queue ON agent_runs (not_before NULLS FIRST, created_at)
  WHERE state = 'queued';

-- The dispatcher's lease sweep: running rows whose lease has passed.
CREATE INDEX run_lease ON agent_runs (lease_until) WHERE state = 'running';
