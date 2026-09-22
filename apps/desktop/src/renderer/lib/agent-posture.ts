// Relayed's run record, as a posture for `@relayed/avatars`.
//
// THE ADAPTER IS THE POINT. The package knows nothing about runs, labels or
// queues — it takes a posture the host has observed, or an id to invent a cycle
// against. Everything this app knows about its own wire format lives here, in
// one file, so the package never has to be edited when that format changes.
//
// NOTE THE GAP. `RunActivity.state` is only `queued | running | waiting`, and
// the server's `labelFor` (apps/server/src/agents/dispatcher.ts) drops the tool
// name for the only two tools a workspace run ever reports — `find_tools` and
// `call_tool` — on the grounds that neither reads well in a sentence. That is
// right for a sentence and costly here: those two are exactly "searching" and
// "using a tool". So `known` is null for a running agent today, and the
// package's cycle carries the interval. The day the dispatcher passes the name
// through, the `run.label` branch below starts firing and the cycle retires
// itself, with nothing to change in either place.
import { activityForTool, type AgentActivity } from '@relayed/avatars';
import { useAgentPosture } from '@relayed/avatars/react';
import type { RunActivity } from '@/lib/agent-activity';

/** What we can actually claim about this run, or null to let the cycle decide. */
function observed(run: RunActivity | null | undefined): AgentActivity | null {
  if (!run) return 'idle';
  if (run.state === 'waiting' || run.state === 'queued') return 'waiting';
  // A label means the server told us something real. Believe it over the cycle.
  return run.label ? activityForTool(run.label) : null;
}

/** The posture to draw an agent in for one of its runs. */
export function useRunPosture(run: RunActivity | null | undefined): AgentActivity {
  return useAgentPosture({ runId: run?.runId ?? null, known: observed(run) });
}
