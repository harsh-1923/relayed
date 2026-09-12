// The agent runtime (docs/AGENT-RUNTIME.md).
//
// Importing ./env.ts is what makes this fail closed: a missing S2S key or a
// malformed provider table throws there, before a listener exists. A config
// typo should be a crash loop somebody notices, never a silently public
// code-execution endpoint (§5).
import Fastify from 'fastify';
import { env } from './env.ts';
import { runRoutes } from './routes.ts';
import { modelRuntime, describeProviders } from './providers.ts';
import { abortAll, activeCount, beginDraining, describeActive, isDraining } from './runs.ts';

const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

// An empty body with `content-type: application/json` means `{}`, not a client
// error — same reasoning as apps/server: plenty of HTTP libraries set the
// header unconditionally, and /run/:id/cancel takes no body.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const raw = (body as string).trim();
  if (raw.length === 0) { done(null, {}); return; }
  try { done(null, JSON.parse(raw)); }
  catch (e) { done(e as Error, undefined); }
});

app.get('/health', async () => ({ ok: true, service: 'relayed-agent' }));
app.get('/healthz/ready', async (_req, reply) =>
  isDraining()
    ? reply.code(503).send({ ready: false, draining: true, activeRuns: activeCount() })
    : reply.send({ ready: true, activeRuns: activeCount() }));

await app.register(runRoutes);

// Build the provider table before listening, so a bad entry is a boot failure
// rather than a 500 on the first run.
await modelRuntime();
app.log.info({ providers: describeProviders(), fallback: `${env.fallback.provider}/${env.fallback.model}` },
  'provider table registered');

await app.listen({ port: env.port, host: '127.0.0.1' });

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    beginDraining();
    // At drain START. If the process is killed harder than SIGTERM, this is the
    // only surviving record of which runs died — written at the end, it is
    // written exactly when it cannot be.
    for (const run of describeActive()) app.log.warn({ ...run, signal: sig }, 'in flight at drain');

    const deadline = setTimeout(() => {
      const aborted = abortAll('cancelled');
      if (aborted > 0) app.log.warn({ aborted }, 'drain deadline reached');
      void app.close().then(() => process.exit(0));
    }, env.drainTimeoutMs);

    const poll = setInterval(() => {
      if (activeCount() > 0) return;
      clearInterval(poll);
      clearTimeout(deadline);
      void app.close().then(() => process.exit(0));
    }, 250);
  });
}

// A stray rejection in SDK code says nothing about process health, and exiting
// here would turn one harmless race into every in-flight run dying. Log it so
// the call site gets a .catch; only a genuine uncaughtException is fatal.
process.on('unhandledRejection', reason => {
  app.log.error({ reason }, 'unhandledRejection (non-fatal — add a .catch at the call site)');
});
