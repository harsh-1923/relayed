import Fastify from 'fastify';
import { emit, useOtlpIfConfigured } from '@relayed/telemetry';
import { env } from './env.ts';
import { migrate } from './db/migrate.ts';
import { authRoutes } from './auth/routes.ts';
import { invitationRoutes } from './auth/invitations.ts';
import { landingRoutes } from './web/landing.ts';
import { pool } from './db/client.ts';
import { startPoller } from './workos/poller.ts';

useOtlpIfConfigured('server');

const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

/**
 * An empty body with `content-type: application/json` means `{}`, not a client
 * error.
 *
 * Fastify rejects it with FST_ERR_CTP_EMPTY_JSON_BODY by default, which turns
 * every bodyless POST — revoking an invitation, signing out — into a 400 for
 * any client whose HTTP library sets the header unconditionally. Plenty do.
 * Found by an end-to-end run where `POST /invitations/:id/revoke` returned 400
 * and looked, from the outside, exactly like a broken route.
 */
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const raw = (body as string).trim();
  if (raw.length === 0) { done(null, {}); return; }
  try { done(null, JSON.parse(raw)); }
  catch (e) { done(e as Error, undefined); }
});

app.get('/health', async () => ({ ok: true, service: 'relayed-server' }));
await app.register(authRoutes);
await app.register(invitationRoutes);
await app.register(landingRoutes);

const applied = await migrate();
if (applied.length) app.log.info({ applied }, 'migrations applied');

// Reconciles what WorkOS knows into our mirror. Started after listen so a slow
// or unreachable WorkOS delays no request; the first tick is a second out.
const stopPoller = startPoller(Number(process.env['WORKOS_POLL_MS'] ?? 30_000));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => { stopPoller(); void pool.end(); process.exit(0); });
}

await app.listen({ port: env.port, host: '127.0.0.1' });
emit('app.boot', { to_first_render: 0, from_local: false });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => { void app.close().then(() => pool.end()).then(() => process.exit(0)); });
}
