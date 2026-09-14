// The working indicator, pushed live while a workspace agent's run is queued
// or running (docs/WORKSPACE-AGENTS.md §5.7). Ephemeral: never stored, and
// never an invalidation — the reply itself arrives through the normal synced
// path regardless of whether this push is ever seen.
export interface AgentActivity {
  chat_id: string;
  /** The reply's thread: the trigger's own thread root, or the trigger itself. */
  thread_id: string;
  agent_id: string;
  run_id: string;
  /** Rises per run. A client drops anything with a lower `seq` than it holds. */
  seq: number;
  state: 'queued' | 'running' | 'waiting' | 'ended';
  /** The current tool's name, from the catalogue; absent while queued or waiting. */
  label?: string;
}

export const AGENT_ACTIVITY_CHANNEL = 'agent:activity' as const;
