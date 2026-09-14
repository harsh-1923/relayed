// The active-run registry and the result shape both modes share
// (docs/AGENT-RUNTIME.md §3, §6).
//
// The map is small and load-bearing: it is what makes /cancel possible, what
// lets readiness report honestly, and what lets SIGTERM say which runs it is
// about to kill. In-process, which is correct for one replica and wrong for two.
import { env } from './env.ts';

export type RunStatus = 'completed' | 'failed' | 'cancelled' | 'timeout';
export type RunMode = 'json' | 'stream';

export interface ToolCall {
  name: string;
  ok: boolean;
  ms: number;
}

/** The terminal payload. In stream mode this is the `done` frame's `result`. */
export interface RunResult {
  runId: string;
  status: RunStatus;
  text: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number; cacheRead: number };
  turns: number;
  provider: string;
  durationMs: number;
  error?: string;
}

interface ActiveRun {
  runId: string;
  mode: RunMode;
  provider: string;
  startedAtMs: number;
  /** Stops the agent loop. Safe to call more than once. */
  abort: (why: Exclude<RunStatus, 'completed'>) => void;
}

const active = new Map<string, ActiveRun>();
let draining = false;

export const beginDraining = (): void => { draining = true; };
export const isDraining = (): boolean => draining;
export const activeCount = (): number => active.size;

/**
 * Capacity check and registration in one step, so two requests cannot both pass.
 *
 * `runId` is the caller's — the server's `agent_runs.id` — never minted here
 * (WORKSPACE-AGENTS.md §5.4): two ids for one run is exactly the drift a
 * runtime-minted id would invite.
 */
export function admit(runId: string, mode: RunMode, provider: string, abort: ActiveRun['abort']): ActiveRun | null {
  if (active.size >= env.maxConcurrentRuns) return null;
  if (active.has(runId)) return null;
  const run: ActiveRun = { runId, mode, provider, startedAtMs: Date.now(), abort };
  active.set(run.runId, run);
  return run;
}

export const release = (runId: string): void => { active.delete(runId); };

export function cancel(runId: string): boolean {
  const run = active.get(runId);
  if (!run) return false;
  run.abort('cancelled');
  return true;
}

/**
 * One line per in-flight run, for the drain log.
 *
 * Called at drain START, never at drain end: if the process is killed harder
 * than SIGTERM this is the only surviving record of what died, and written at
 * the end it is written exactly when it cannot be.
 */
export function describeActive(): Array<{ runId: string; provider: string; ageMs: number }> {
  const now = Date.now();
  return [...active.values()].map(r => ({ runId: r.runId, provider: r.provider, ageMs: now - r.startedAtMs }));
}

export function abortAll(why: Exclude<RunStatus, 'completed'>): number {
  const runs = [...active.values()];
  for (const run of runs) run.abort(why);
  return runs.length;
}
