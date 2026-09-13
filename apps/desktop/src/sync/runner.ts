// The sync engine's end of the agent runner's port (docs/LOCAL-ROOMS.md §5).
//
// To the sync engine the runner is another socket: requests go out, replies and
// events come back, and nothing here writes a row on the runner's say-so
// without going through the same handlers everything else does.
//
// The port is REPLACED, never repaired. Main mints a fresh channel whenever the
// runner or this process is started, so a dead port is not reconnected — every
// request waiting on it is failed at once, rather than left to time out.
import type { RunnerEvent, RunnerMessage, RunnerOp, RunnerOps, RunnerRequest } from '../shared/claude.ts';

/** The part of Electron's `MessagePortMain` this uses, so a test can hand in a fake. */
export interface RunnerPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  start(): void;
}

/** A probe takes about a second; a turn's requests are answered immediately. Anything past this is stuck. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface RunnerLink {
  attach(port: RunnerPort): void;
  readonly attached: boolean;
  request<Op extends RunnerOp>(op: Op, params: RunnerOps[Op]['params']): Promise<RunnerOps[Op]['result']>;
}

export interface RunnerLinkHooks {
  /** A report the runner sent unasked: a turn's text, parts, session or end. */
  onEvent?: (event: RunnerEvent) => void;
  /**
   * The runner's port closed or was replaced. Every Claude Code child it held
   * is gone, so every turn it was running is over, whatever it last reported.
   */
  onDetach?: () => void;
}

export function createRunnerLink(hooks: RunnerLinkHooks = {}, timeoutMs = REQUEST_TIMEOUT_MS): RunnerLink {
  let port: RunnerPort | null = null;
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
  }>();

  const failAll = (reason: string): void => {
    for (const [id, waiting] of pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
      pending.delete(id);
    }
  };

  return {
    get attached() { return port !== null; },

    attach(next) {
      // Requests sent on the old port will never be answered on this one.
      if (port) { failAll('the agent runner restarted'); hooks.onDetach?.(); }
      port = next;
      next.on('message', ({ data }) => {
        const message = data as RunnerMessage;
        if ('event' in message) { hooks.onEvent?.(message); return; }
        const reply = message;
        const waiting = pending.get(reply.id);
        if (!waiting) return;
        pending.delete(reply.id);
        clearTimeout(waiting.timer);
        if (reply.ok) waiting.resolve(reply.data);
        else waiting.reject(new Error(reply.error));
      });
      next.on('close', () => {
        if (port !== next) return;
        port = null;
        failAll('the agent runner stopped');
        hooks.onDetach?.();
      });
      next.start();
    },

    request(op, params) {
      const current = port;
      if (!current) return Promise.reject(new Error('the agent runner is not running'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`the agent runner did not answer ${op} within ${timeoutMs / 1000}s`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        current.postMessage({ id, op, params } satisfies RunnerRequest);
      });
    },
  };
}
