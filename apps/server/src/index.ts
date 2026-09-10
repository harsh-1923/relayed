import Fastify from 'fastify';
import { emit, useOtlpIfConfigured } from '@relayed/telemetry';
import { env } from './env.ts';
import { migrate } from './db/migrate.ts';
import { authRoutes } from './auth/routes.ts';
import { invitationRoutes } from './auth/invitations.ts';
import { landingRoutes } from './web/landing.ts';
import { pool, db } from './db/client.ts';
import { startPoller } from './workos/poller.ts';
import { attachSyncSocket, SYNC_PATH } from './sync/socket.ts';

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

// The sync socket, on Fastify's own HTTP server rather than a second listener:
// one port, one TLS terminator, and an upgrade that a proxy already knows how
// to route. Attached before `listen` so no connection can arrive first.
const sync = attachSyncSocket(app.server, {
  db,
  onEvent: (name, detail) => { app.log.debug({ ...detail }, name); },
});
app.log.info({ path: SYNC_PATH }, 'sync socket attached');

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
  process.once(sig, () => {
    // Sockets first, and told WHY. A deploy that just drops connections leaves
    // every client discovering it at its next heartbeat — up to a minute of
    // silence that looks exactly like a network fault. Closing with a code lets
    // them reconnect immediately, on a jittered delay so they do not arrive
    // together (invariant 31).
    void sync.close()
      .then(() => app.close())
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}
