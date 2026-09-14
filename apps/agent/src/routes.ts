// The entry point (docs/AGENT-RUNTIME.md §3).
//
// One endpoint, two transports. The body describes the RUN; the `Accept`
// header describes how the answer travels — so the response's content type and
// the request's expectation agree by construction, which a `"stream": true`
// field could not guarantee.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RunRequest as RunRequestSchema, type RunRequest } from '@relayed/protocol';
import { env } from './env.ts';
import { startRun, NULL_SINK } from './agent.ts';
import { UnknownModelError } from './providers.ts';
import { openSse } from './stream.ts';
import { admit, cancel, isDraining, release, type RunMode } from './runs.ts';

function authorized(req: FastifyRequest): boolean {
  const given = req.headers['x-agent-key'];
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(env.s2sKey);
  // timingSafeEqual throws on a length mismatch, and the length is not secret.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Rejects before a single token is spent. A 500 after spending is the wrong
 * default. Validated against the same schema the server built the request
 * from (`@relayed/protocol`, WORKSPACE-AGENTS.md §5.4) — `runId`, `palette`
 * and `tools` included, so this and the dispatcher can never quietly drift.
 */
function parseBody(body: unknown): RunRequest | string {
  const result = RunRequestSchema.safeParse(body);
  if (!result.success) return result.error.issues[0]?.message ?? 'invalid request body';
  if (result.data.prompt.trim().length === 0) return 'prompt is required and must be a non-empty string';
  return result.data;
}

export async function runRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health' || req.url === '/healthz/ready') return;
    if (!authorized(req)) await reply.code(401).send({ error: 'invalid or missing x-agent-key' });
  });

  app.post('/run', async (req: FastifyRequest, reply: FastifyReply) => {
    if (isDraining()) {
      return reply.code(503).send({ error: 'draining' });
    }

    const parsed = parseBody(req.body ?? {});
    if (typeof parsed === 'string') {
      return reply.code(400).send({ error: parsed });
    }

    // Resolve before admitting: an unknown model is the caller's mistake, not
    // a reason to occupy a concurrency slot.
    const { resolveModel } = await import('./providers.ts');
    let provider: string;
    try {
      provider = (await resolveModel(parsed.model)).provider;
    } catch (err) {
      if (err instanceof UnknownModelError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }

    const mode: RunMode = (req.headers['accept'] ?? '').includes('text/event-stream') ? 'stream' : 'json';

    // Declared for the run we are about to start, then replaced once the
    // handle exists. A cancel cannot arrive before the slot is registered.
    let abortHandle: ((why: 'failed' | 'cancelled' | 'timeout') => void) | undefined;
    const active = admit(parsed.runId, mode, provider, why => abortHandle?.(why));
    if (!active) {
      return reply.code(429).send({ error: 'at capacity', maxConcurrentRuns: env.maxConcurrentRuns });
    }

    // One line per request, unconditionally: "the caller asked for a stream and
    // the runtime answered in JSON" is diagnosable from this or from nothing.
    req.log.info({ runId: active.runId, mode, provider, model: parsed.model ?? 'fallback' }, 'run accepted');

    if (mode === 'stream') {
      reply.hijack();
      const sse = openSse(reply.raw, active.runId);
      const run = startRun(parsed, sse.sink);
      abortHandle = run.abort;
      // Nobody is listening and there is nowhere to put the answer.
      sse.onClose(() => run.abort('cancelled'));
      try {
        const result = await run.result;
        sse.done(result);
      } finally {
        release(active.runId);
      }
      return reply;
    }

    const run = startRun(parsed, NULL_SINK);
    abortHandle = run.abort;
    // The connection IS the destination; if it goes away, stop spending.
    req.raw.on('close', () => { if (!reply.sent) run.abort('cancelled'); });
    try {
      const result = await run.result;
      // A run that started and failed is a 200 with status:"failed" — it has a
      // runId worth correlating and it consumed tokens. Collapsing it into a
      // 500 throws away the only record that the work happened.
      return reply.code(200).send(result);
    } finally {
      release(active.runId);
    }
  });

  app.post('/run/:runId/cancel', async (req: FastifyRequest<{ Params: { runId: string } }>, reply) => {
    const found = cancel(req.params.runId);
    return reply.code(found ? 202 : 404).send({ runId: req.params.runId, cancelled: found });
  });
}
