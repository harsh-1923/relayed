import Fastify from 'fastify';
import { emit, useOtlpIfConfigured } from '@relayed/telemetry';
import { env } from './env.ts';
import { migrate } from './db/migrate.ts';
import { authRoutes } from './auth/routes.ts';
import { pool } from './db/client.ts';

useOtlpIfConfigured('server');

const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

app.get('/health', async () => ({ ok: true, service: 'relayed-server' }));
await app.register(authRoutes);

const applied = await migrate();
if (applied.length) app.log.info({ applied }, 'migrations applied');

await app.listen({ port: env.port, host: '127.0.0.1' });
emit('app.boot', { to_first_render: 0, from_local: false });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => { void app.close().then(() => pool.end()).then(() => process.exit(0)); });
}
