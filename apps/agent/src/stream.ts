// SSE framing for stream mode (docs/AGENT-RUNTIME.md §3).
//
// Five rules hold this together, and each exists because its absence is a bug
// a consumer finds rather than a test does:
//   1. `done` carries exactly the JSON mode's body — one result, two envelopes.
//   2. Every frame carries a monotonic `seq`, so a gap is detectable.
//   3. A terminal frame is ALWAYS written before close, including on failure
//      and during drain. A stream that just ends looks like a dropped socket.
//   4. Keepalive comments every 25s, so nothing in the middle idles out a run.
//   5. Deltas are coalesced — raw token frames are almost all volume and
//      almost no information.
import type { ServerResponse } from 'node:http';
import { env } from './env.ts';
import type { RunSink } from './agent.ts';
import type { RunResult } from './runs.ts';

const KEEPALIVE_MS = 25_000;

export interface SseStream {
  sink: RunSink;
  /** Writes the terminal frame and ends the response. Idempotent. */
  done(result: RunResult): void;
  /** The consumer went away. */
  onClose(handler: () => void): void;
}

export function openSse(res: ServerResponse, runId: string): SseStream {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Named for nginx, which otherwise buffers the whole stream and delivers
    // it at the end — which looks exactly like streaming being broken.
    'X-Accel-Buffering': 'no',
  });

  let seq = 0;
  let closed = false;

  const write = (event: string, data: Record<string, unknown>): void => {
    if (closed || res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify({ seq: seq++, ...data })}\n\n`);
    } catch {
      // The socket went away between the check and the write. The close
      // handler is what reacts; there is nothing useful to do here.
    }
  };

  // Text arrives token by token. Holding it briefly turns hundreds of frames
  // into a handful without the consumer noticing the difference.
  let pendingText = '';
  let pendingReasoning = '';
  let flushTimer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    flushTimer = undefined;
    if (pendingText.length > 0) { write('delta', { text: pendingText }); pendingText = ''; }
    if (pendingReasoning.length > 0) { write('reasoning', { text: pendingReasoning }); pendingReasoning = ''; }
  };

  const scheduleFlush = (): void => {
    flushTimer ??= setTimeout(flush, env.streamCoalesceMs);
  };

  const keepalive = setInterval(() => {
    if (closed || res.writableEnded) return;
    try { res.write(': keepalive\n\n'); } catch { /* socket already gone */ }
  }, KEEPALIVE_MS);
  keepalive.unref();

  write('started', { runId });

  const sink: RunSink = {
    delta: text => { pendingText += text; scheduleFlush(); },
    reasoning: text => {
      if (!env.exposeReasoning) return;
      pendingReasoning += text;
      scheduleFlush();
    },
    toolStart: (name, id) => { flush(); write('tool', { phase: 'start', name, id }); },
    toolEnd: call => {
      flush();
      write('tool', { phase: 'end', name: call.name, id: call.id, ok: call.ok, ms: call.ms });
    },
  };

  return {
    sink,
    done: (result: RunResult) => {
      if (closed) return;
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      write('done', { result });
      closed = true;
      clearInterval(keepalive);
      if (!res.writableEnded) res.end();
    },
    onClose: handler => {
      res.on('close', () => {
        if (closed) return;
        // Distinguishes "we finished and ended the response" from "the consumer
        // hung up": only the latter leaves writableEnded false.
        closed = true;
        if (flushTimer) clearTimeout(flushTimer);
        clearInterval(keepalive);
        handler();
      });
    },
  };
}
