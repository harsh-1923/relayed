// The server's call to `apps/agent` (docs/WORKSPACE-AGENTS.md §5.3;
// `AGENT-RUNTIME.md` §3). Stream mode, because the working indicator needs
// tool-start events as they happen — the dispatcher does not wait for `done`
// to know an agent is "Searching Linear".
//
// Three traps, each of which has cost a production agent platform real runs
// (§5.3), and each named at the line that avoids it:
//
//   1. Node's HTTP client closes a response body that goes quiet — undici's
//      default bodyTimeout is 300s, and the runtime's keepalives arrive every
//      ~25s, so this sets it explicitly ABOVE that rather than trusting the
//      default to be generous enough.
//   2. A gone consumer is detected on the RESPONSE's close, which is what
//      `request()`'s body stream gives — never the request's, which fires the
//      moment the body is read and would abort a run the instant it started.
//   3. A stream that ends with no `done` frame is INTERRUPTED, not failed: the
//      runtime aborts when its caller disappears, so nothing failed at
//      anything.
import { request as undiciRequest } from 'undici';
import { parseSseFrame, type RunRequest, type RunResultBody, type SseEventName } from '@relayed/protocol';
import { env } from '../env.ts';

/** Above the runtime's ~25s keepalive, with slack — trap 1. */
const BODY_TIMEOUT_MS = 90_000;

/** One frame from the runtime's stream, as the dispatcher needs it. */
export type RuntimeEvent =
  | { kind: 'started' }
  | { kind: 'tool_start'; name: string; id: string }
  | { kind: 'tool_end'; name: string; id: string; ok: boolean; ms: number }
  | { kind: 'done'; result: RunResultBody };

/** The stream ended with no terminal frame — trap 3. Not a `RunResultBody`: nothing ran to completion. */
export class RuntimeInterruptedError extends Error {
  constructor() { super('the runtime stream ended with no done frame'); this.name = 'RuntimeInterruptedError'; }
}

/** The runtime could not be reached at all, or refused the request outright. */
export class RuntimeUnavailableError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'RuntimeUnavailableError';
    this.status = status;
  }
}

/**
 * Call `/run` in stream mode, yielding events as they arrive. The caller
 * drives the loop; aborting `signal` ends the underlying request (used by
 * `/agent-runs/:id/stop`, §5.8).
 */
export async function* callRuntime(body: RunRequest, signal: AbortSignal): AsyncGenerator<RuntimeEvent> {
  if (!env.agentRuntimeUrl || !env.agentS2sKey) {
    throw new RuntimeUnavailableError('the agent runtime is not configured');
  }

  let res;
  try {
    res = await undiciRequest(`${env.agentRuntimeUrl}/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-agent-key': env.agentS2sKey,
      },
      body: JSON.stringify(body),
      bodyTimeout: BODY_TIMEOUT_MS,
      headersTimeout: BODY_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err;
    throw new RuntimeUnavailableError((err as Error).message);
  }

  if (res.statusCode === 429) throw new RuntimeUnavailableError('the runtime is at capacity', 429);
  if (res.statusCode >= 400) {
    // Drained rather than left dangling: an unconsumed body on a keep-alive
    // connection is a leaked socket.
    await res.body.text().catch(() => '');
    throw new RuntimeUnavailableError(`the runtime refused the run (${res.statusCode})`, res.statusCode);
  }

  let buffer = '';
  let sawDone = false;
  // Trap 2: this loop reads the RESPONSE body — the consumer's own close, not
  // the request's — so it ends only when the runtime actually stops sending,
  // never the instant the request was written.
  for await (const chunk of res.body) {
    buffer += (chunk as Buffer).toString('utf8');
    let boundary: number;
    // SSE frames are separated by a blank line.
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseBlock(block);
      if (!event) continue;   // a keepalive comment, or a frame this build does not know (invariant 43's sibling)
      if (event.event === 'done') sawDone = true;
      const mapped = toRuntimeEvent(event);
      if (mapped) yield mapped;
    }
  }

  if (!sawDone) throw new RuntimeInterruptedError();
}

/** One `event: … \n data: …` block, or null for anything not shaped like an SSE event. */
function parseBlock(block: string): { event: SseEventName; data: unknown } | null {
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;   // a keepalive comment
    if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (!eventName || dataLines.length === 0) return null;
  const frame = parseSseFrame(eventName, dataLines.join('\n'));
  return frame ? { event: frame.event, data: frame.data } : null;
}

function toRuntimeEvent(frame: { event: SseEventName; data: unknown }): RuntimeEvent | null {
  switch (frame.event) {
    case 'started': return { kind: 'started' };
    case 'tool': {
      const data = frame.data as { phase: 'start' | 'end'; name: string; id: string; ok?: boolean; ms?: number };
      return data.phase === 'start'
        ? { kind: 'tool_start', name: data.name, id: data.id }
        : { kind: 'tool_end', name: data.name, id: data.id, ok: data.ok ?? false, ms: data.ms ?? 0 };
    }
    case 'done':
      return { kind: 'done', result: (frame.data as { result: RunResultBody }).result };
    // `delta` and `reasoning` are for a live reply UI, which synced rooms do
    // not have yet (`AGENT-RESPONSES.md` §3.4 leaves streaming open); the
    // dispatcher does not need them to know when a run finished.
    default:
      return null;
  }
}
