-- Tool input schemas, in the catalogue (WORKSPACE-AGENTS.md §6.6, §6.7).
--
-- Composio's catalogue endpoint (GET /tools) carries the same JSON Schema the
-- session-tools endpoint does — confirmed live, undocumented — which is what
-- lets `dispatcher.ts` hand the runtime a real tool definition without a live
-- Composio session, and therefore without the invoker's connection needing
-- to exist yet. Without this column the only source of a schema was a
-- session, which only exists once a connection does — exactly backwards from
-- what raising an access card requires.
ALTER TABLE toolkit_tools ADD COLUMN input_schema JSONB NOT NULL DEFAULT '{"type":"object","properties":{}}'::jsonb;
