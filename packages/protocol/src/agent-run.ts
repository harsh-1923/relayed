// The wire between the server and the agent runtime (docs/AGENT-RUNTIME.md §3;
// docs/WORKSPACE-AGENTS.md §5.4). The body crossed the "third field" line —
// `runId`, `palette` and `tools` are new in the same change — which is
// `AGENT-RUNTIME.md`'s own trigger for giving a wire format a Zod schema
// (`FRONTEND.md` §8.3). It covers the SSE frames too: a stream nothing
// validates is a wire format nobody actually checks.
//
// Both sides import this. The server builds a `RunRequest` and sends it; the
// runtime parses one on the way in and answers with `RunResultBody`, in JSON
// mode directly and in stream mode as the `done` frame's `result`.
import { z } from 'zod';

export const THINKING_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * A remote tool's definition, as the runtime registers it with pi.
 *
 * `parameters` is JSON Schema, exactly as Composio returns it — this schema
 * does not interpret it, only carries it, because doing more would mean
 * keeping a second opinion about a shape Composio already owns.
 */
export const RunTool = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});
export type RunTool = z.infer<typeof RunTool>;

/**
 * The `/run` request body (WORKSPACE-AGENTS.md §5.4).
 *
 * `runId` is the SERVER's id — the one on `agent_runs`, the grant and the
 * reply — never minted by the runtime. Two ids for one run is exactly the
 * drift `AGENT-RUNTIME.md` §3 warns a sixty-field body invites one at a time.
 *
 * `palette` is `'default'` for a local room's own Claude Code palette (unused
 * here) and `'none'` for a workspace agent: no `bash`, `read`, `write`,
 * `edit`, `grep`, `find` or `ls` — a workspace agent's prompt is written by
 * whoever mentions it, so removing the tools answers that trigger without a
 * sandbox (`AGENT-RUNTIME.md` §5).
 */
export const RunRequest = z.object({
  runId: z.string().min(1),
  prompt: z.string().min(1),
  systemPrompt: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
  palette: z.enum(['default', 'none']).default('none'),
  tools: z.array(RunTool).default([]),
  /** The only credential the runtime holds for this run (§5.5). Absent for a run with no tools. */
  grant: z.string().optional(),
});
export type RunRequest = z.infer<typeof RunRequest>;

export const RUN_STATUSES = ['completed', 'failed', 'cancelled', 'timeout'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** One JSON-mode response, and what `done`'s `result` carries verbatim. */
export const RunResultBody = z.object({
  runId: z.string(),
  status: z.enum(RUN_STATUSES),
  text: z.string(),
  toolCalls: z.array(z.object({ name: z.string(), ok: z.boolean(), ms: z.number().int().nonnegative() })),
  usage: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
  }),
  turns: z.number().int().nonnegative(),
  provider: z.string(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type RunResultBody = z.infer<typeof RunResultBody>;

// ─── SSE frames (AGENT-RUNTIME.md §3, stream mode) ──────────────────────────
//
// One schema per `event:` name. `seq` is on every frame, monotonic, so a
// consumer can detect a gap instead of silently rendering a hole.

export const StartedFrame = z.object({ seq: z.number().int().nonnegative(), runId: z.string() });
export const DeltaFrame = z.object({ seq: z.number().int().nonnegative(), text: z.string() });
export const ReasoningFrame = z.object({ seq: z.number().int().nonnegative(), text: z.string() });
export const ToolFrame = z.object({
  seq: z.number().int().nonnegative(),
  phase: z.enum(['start', 'end']),
  name: z.string(),
  id: z.string(),
  // Only on `phase: 'end'`.
  ok: z.boolean().optional(),
  ms: z.number().int().nonnegative().optional(),
});
export const DoneFrame = z.object({ seq: z.number().int().nonnegative(), result: RunResultBody });

/** Every SSE event this stream may carry, keyed by its `event:` name. */
export const SSE_FRAMES = {
  started: StartedFrame,
  delta: DeltaFrame,
  reasoning: ReasoningFrame,
  tool: ToolFrame,
  done: DoneFrame,
} as const;
export type SseEventName = keyof typeof SSE_FRAMES;

export type SseFrame =
  | { event: 'started'; data: z.infer<typeof StartedFrame> }
  | { event: 'delta'; data: z.infer<typeof DeltaFrame> }
  | { event: 'reasoning'; data: z.infer<typeof ReasoningFrame> }
  | { event: 'tool'; data: z.infer<typeof ToolFrame> }
  | { event: 'done'; data: z.infer<typeof DoneFrame> };

/**
 * Parse one `event: … \n data: …` block. `null` for anything this reader does
 * not recognise — a keepalive comment, or an event name from a newer
 * runtime — never thrown: the dispatcher's stream loop keeps reading past a
 * frame it does not understand, the same forward-compatibility rule the sync
 * socket holds (invariant 43).
 */
export function parseSseFrame(eventName: string, rawData: string): SseFrame | null {
  const schema = (SSE_FRAMES as Record<string, z.ZodType>)[eventName];
  if (!schema) return null;
  let json: unknown;
  try { json = JSON.parse(rawData); } catch { return null; }
  const result = schema.safeParse(json);
  return result.success ? ({ event: eventName, data: result.data } as SseFrame) : null;
}
