import Fastify from 'fastify';
import { emit, identify, useOtlpIfConfigured, OtlpSink } from '@relayed/telemetry';
import { env } from './env.ts';
import { migrate } from './db/migrate.ts';
import { authRoutes } from './auth/routes.ts';
import { invitationRoutes } from './auth/invitations.ts';
import { orgRoutes } from './org/routes.ts';
import { fileRoutes } from './files/routes.ts';
import { landingRoutes } from './web/landing.ts';
import { versionRoutes } from './web/version.ts';
import { telemetryRoutes } from './web/telemetry.ts';
import { pool, db } from './db/client.ts';
import { startPoller } from './workos/poller.ts';
import { attachSyncSocket, SYNC_PATH } from './sync/socket.ts';
import { startRetention } from './sync/retention.ts';
import { devRoutes } from './web/dev.ts';
import { agentRoutes } from './agents/routes.ts';
import { connectionRoutes } from './agents/connections.ts';
import { permissionRoutes } from './agents/permissions.ts';
import { brokerRoutes } from './agents/broker.ts';
import { accessRoutes } from './agents/access.ts';
import { startCatalogueRefresh } from './agents/catalogue.ts';
import { startDispatcher, type Dispatcher } from './agents/dispatcher.ts';
import { startSummariser } from './agents/summariser.ts';
import { startIngest } from './memory/ingest.ts';
import { startConfiguredAmbient } from './agents/ambient/loop.ts';
import { ambientRoutes } from './agents/ambient/routes.ts';
import { spaceRoutes } from './sync/routes.ts';

useOtlpIfConfigured('server');

// The bounded half only. A server has no device and no signed-in actor — the
// identity that matters here belongs to whoever is on the other end of a
// socket, and that is already on the spans (`sync.hello` carries actor and
// workspace). Attaching a process-level identity would say nothing true.
identify({
  os: process.platform,
  arch: process.arch,
  env: process.env['NODE_ENV'] === 'production' ? 'production' : 'development',
  version: process.env['npm_package_version'] ?? 'dev',
});

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
await app.register(orgRoutes);
await app.register(fileRoutes);
await app.register(landingRoutes);
// Public, and registered beside /health for the same reason: it must answer a
// client that cannot yet authenticate.
await app.register(versionRoutes);

/**
 * Where desktop telemetry lands (OBSERVABILITY.md §3).
 *
 * A SECOND SINK, with `service: 'desktop'`. The same event from a laptop and
 * from this process are different series — merging them under `relayed-server`
 * would make "the server is fine" and "every client is broken" the same shape
 * on a dashboard. Null when no collector is configured, which makes the route
 * a validating no-op rather than an error.
 */
const clientTelemetry = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  ? new OtlpSink({ endpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'], service: 'desktop' })
  : null;
await app.register(telemetryRoutes({ sink: clientTelemetry }));

// The sync socket, on Fastify's own HTTP server rather than a second listener:
// one port, one TLS terminator, and an upgrade that a proxy already knows how
// to route. Attached before `listen` so no connection can arrive first.
// `startDispatcher` needs the socket's registry to push activity and fan out
// replies, and the socket needs the dispatcher to wake it — a genuine cycle,
// broken with a holder set right after both exist. Nothing calls `wake()`
// before then; the earliest an op can arrive is after `listen`, below.
let dispatcher: Dispatcher | undefined;
const sync = attachSyncSocket(app.server, {
  db,
  onEvent: (name, detail) => { app.log.debug({ ...detail }, name); },
  dispatcher: { wake: () => dispatcher?.wake() },
});
app.log.info({ path: SYNC_PATH }, 'sync socket attached');

dispatcher = startDispatcher(db, sync.registry);

// After the socket, because agent writes deliver their directory events through
// it the moment they commit.
await app.register(agentRoutes({
  db, deliver: sync.deliver, registry: sync.registry,
  dispatcher: { cancel: (runId) => dispatcher?.cancel(runId) },
}));
await app.register(spaceRoutes({ db, deliver: sync.deliver, registry: sync.registry }));
await app.register(ambientRoutes({ db }));
await app.register(connectionRoutes({ db, registry: sync.registry }));
await app.register(permissionRoutes({
  db, deliver: sync.deliver, registry: sync.registry, dispatcher: { wake: () => dispatcher?.wake() },
}));
await app.register(brokerRoutes({ db, deliver: sync.deliver, dispatcher: { wake: () => dispatcher?.wake() } }));
await app.register(accessRoutes({
  db, deliver: sync.deliver, registry: sync.registry, dispatcher: { wake: () => dispatcher?.wake() },
}));

// Development only, and said so in the log: a route that writes messages
// nobody authenticated is fine on a laptop and nowhere else.
if (env.devRoutes) {
  await app.register(devRoutes({ db, deliver: sync.deliver }));
  app.log.warn('RELAYED_DEV_ROUTES is set: /dev routes are registered');
}

const applied = await migrate();
if (applied.length) app.log.info({ applied }, 'migrations applied');

// Reconciles what WorkOS knows into our mirror. Started after listen so a slow
// or unreachable WorkOS delays no request; the first tick is a second out.
const stopPoller = startPoller(Number(process.env['WORKOS_POLL_MS'] ?? 30_000));

// Trims `sync_events` past the retention horizon, hourly, in bounded passes.
// Nothing depends on it having run: the worst case of a missed sweep is a
// larger table and, eventually, a client getting a gap where it would have got
// a replay.
const stopRetention = startRetention(db, Number(process.env['RETENTION_MS'] ?? 3_600_000),
  (deleted, passes) => { app.log.info({ deleted, passes }, 'retention swept'); });

// Keeps `toolkits`/`toolkit_tools` current from Composio's own catalogue
// (WORKSPACE-AGENTS.md §6.6). Ticks immediately, so a fresh boot does not
// wait a day for the enabled toolkits' tools to appear.
const stopCatalogue = startCatalogueRefresh(db);

// Keeps each room's summary current (DOCUMENTS.md §4). A job rather than a
// run: it has no invoker and spends nobody's authority, so it needs the socket
// registry only to fan out the revision it writes.
const summariser = startSummariser(db, sync.registry);

// Memory ingestion (docs/MEMORY.md §6). A job like the summariser and for the
// same reason — nobody asked for it, so it has no invoker whose authority it
// could spend — but it needs no registry: it writes nothing a client syncs.
// Off unless MEMORY_INGEST=1, and it says so rather than starting silently.
const ingest = startIngest(db, sync.registry);

// Ambient answers (docs/AMBIENT-RESPONSES.md): an agent answering a message
// that did not mention it. A job like the two above — nobody asked, so there is
// no invoker — and found by polling after commit, never from the send path.
// Off unless AMBIENT_MODE is shadow or live, and it says so either way.
const ambient = startConfiguredAmbient(db, sync.registry);

await app.listen({ port: env.port, host: env.host });
emit('app.boot', { to_first_render: 0, from_local: false });

/**
 * ONE handler for both signals, and it must stay one.
 *
 * This was two: a first that stopped the jobs and called `process.exit(0)`
 * synchronously, and a second, registered after `listen`, that closed the
 * sockets with a code first. Node runs listeners in registration order, so the
 * first one's exit pre-empted the second and the socket close never ran: the
 * second handler carried a careful comment about behaviour the process could
 * not reach.
 *
 * The cost was paid on every deploy: clients discovered the restart at their
 * next heartbeat instead of being told, which is up to a minute of silence that
 * looks exactly like a network fault.
 *
 * ORDER IS THE POINT. Jobs first, so nothing new is written into a server that
 * is leaving. Then the sockets, told WHY, so each client reconnects immediately
 * on a jittered delay rather than arriving together (invariant 31). Then
 * Fastify, then the pool.
 */
let leaving = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    // `once` is per signal, so a SIGTERM followed by a SIGINT would otherwise
    // start a second shutdown over the top of the first.
    if (leaving) return;
    leaving = true;

    stopPoller(); stopRetention(); stopCatalogue(); summariser.stop(); ingest.stop(); ambient.stop(); dispatcher?.stop();

    void sync.close()
      .then(() => app.close())
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}
