// The entry point (docs/AGENT-RUNTIME.md §3).
//
// One endpoint, two transports. The body describes the RUN; the `Accept`
// header describes how the answer travels — so the response's content type and
// the request's expectation agree by construction, which a `"stream": true`
// field could not guarantee.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from './env.ts';
import { startRun, NULL_SINK, THINKING_LEVELS, type RunRequest, type ThinkingLevel } from './agent.ts';
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

interface RunBody {
  prompt?: unknown;
  systemPrompt?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
}

/** Rejects before a single token is spent. A 500 after spending is the wrong default. */
function parseBody(body: RunBody): RunRequest | string {
  if (typeof body?.prompt !== 'string' || body.prompt.trim().length === 0) {
    return 'prompt is required and must be a non-empty string';
  }
  if (body.systemPrompt !== undefined && typeof body.systemPrompt !== 'string') {
    return 'systemPrompt must be a string';
  }
  if (body.model !== undefined && typeof body.model !== 'string') {
    return 'model must be a string';
  }
  if (body.thinkingLevel !== undefined
      && !THINKING_LEVELS.includes(body.thinkingLevel as ThinkingLevel)) {
    return `thinkingLevel must be one of: ${THINKING_LEVELS.join(', ')}`;
  }
  // An empty string is "not provided", not "a model named nothing". Callers
  // template these fields (a Postman variable, an env var, a config value), and
  // an unfilled template should fall back to the default rather than 400.
  const blank = (v: unknown): string | undefined => {
    const trimmed = typeof v === 'string' ? v.trim() : '';
    return trimmed.length > 0 ? trimmed : undefined;
  };
  return {
    prompt: body.prompt.trim(),
    systemPrompt: blank(body.systemPrompt),
    model: blank(body.model),
    thinkingLevel: body.thinkingLevel as ThinkingLevel | undefined,
  };
}

export async function runRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health' || req.url === '/healthz/ready') return;
    if (!authorized(req)) await reply.code(401).send({ error: 'invalid or missing x-agent-key' });
  });

  app.post('/run', async (req: FastifyRequest<{ Body: RunBody }>, reply: FastifyReply) => {
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
    const active = admit(mode, provider, why => abortHandle?.(why));
    if (!active) {
      return reply.code(429).send({ error: 'at capacity', maxConcurrentRuns: env.maxConcurrentRuns });
    }

    // One line per request, unconditionally: "the caller asked for a stream and
    // the runtime answered in JSON" is diagnosable from this or from nothing.
    req.log.info({ runId: active.runId, mode, provider, model: parsed.model ?? 'fallback' }, 'run accepted');

    if (mode === 'stream') {
      reply.hijack();
      const sse = openSse(reply.raw, active.runId);
      const run = startRun(active.runId, parsed, sse.sink);
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

    const run = startRun(active.runId, parsed, NULL_SINK);
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
