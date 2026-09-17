-- What an agent asked the app itself to do (docs/WORKSPACE-AGENTS.md §5.5):
-- start a side chat, post a message, read a summary — every tool `tools/`
-- answers. `agent_tool_calls` is the connected-services audit, with its own
-- permission and connection outcomes, and what a reply lists; these are kept
-- apart so neither changes meaning.
--
-- For finding out what a run DID, rather than what it said it did. A retried
-- call keeps one row, updated to its latest answer.
CREATE TABLE agent_app_tool_calls (
  run_id        TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_call_id  TEXT NOT NULL,
  tool          TEXT NOT NULL,
  -- The tool's `result`: ok, failed, not_a_member, tool_not_allowed, … — or
  -- 'error' when the handler threw.
  result        TEXT NOT NULL,
  -- What the model was told, for a result other than ok.
  message       TEXT,
  -- Truncated to 8 KB before it is written, like `agent_tool_calls.arguments`.
  arguments     JSONB,
  duration_ms   INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, tool_call_id)
);
CREATE INDEX agent_app_tool_calls_created ON agent_app_tool_calls (created_at);
