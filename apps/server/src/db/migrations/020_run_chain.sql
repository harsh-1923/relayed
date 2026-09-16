-- How far a run is from the person who started it (docs/WORKSPACE-AGENTS.md,
-- agents mentioning agents).
--
-- A person's mention starts a run at depth 1. A message an agent writes during
-- a run — its reply, or a message it posts — starts the agents it mentions at
-- that run's depth + 1, for the same person: the chained run's invoker is the
-- original person, whose permissions and connections it spends. Nothing is
-- started past depth 3, which is what stops two agents mentioning each other
-- from running for ever.
ALTER TABLE agent_runs ADD COLUMN chain_depth INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_runs ADD CONSTRAINT run_chain_depth CHECK (chain_depth >= 1);
