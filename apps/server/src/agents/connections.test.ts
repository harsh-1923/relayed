// `/connections/:id/fail` (docs/WORKSPACE-AGENTS.md §6.5): the desktop's own
// admission that a connect attempt never reached `/complete`. Through
// Fastify's `inject`, against Postgres — Composio is never called by this
// route, so nothing here needs stubbing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { sql } from 'kysely';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { Registry } from '../sync/registry.ts';
import { connectionRoutes } from './connections.ts';
import { removeTestToolkits, sweepTestToolkits } from '../db/test-toolkits.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const alice = ulid('act');
const bob = ulid('act');
const toolkits: string[] = [];

before(async () => {
  if (!up) return;
  await sweepTestToolkits(db);
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Fail' }).execute();
  await db.insertInto('workspaces').values({ id: wsp, org_id: org, name: 'Fail', slug: `f-${wsp.slice(-8).toLowerCase()}` }).execute();
  for (const id of [alice, bob]) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type: 'human', handle: `f-${id.slice(-8).toLowerCase()}`,
      display_name: 'Person', avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${id}`,
      owner_actor_id: null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member' }).execute();
  }
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('connections').where('workspace_id', '=', wsp).execute();
  await removeTestToolkits(db, toolkits);
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

async function server() {
  const app = Fastify();
  await app.register(connectionRoutes({
    db, registry: new Registry(),
    // `Bearer <actor id>` stands in for a signed token.
    caller: async (authorization) => {
      const actorId = (authorization ?? '').replace(/^Bearer /, '');
      return [alice, bob].includes(actorId)
        ? { actorId, workspaceId: wsp, orgId: org, workosUserId: null } : null;
    },
  }));
  return app;
}

const as = (actorId: string) => ({ authorization: `Bearer ${actorId}` });

/**
 * A row exactly as `POST /connections` leaves one mid-attempt: no completed
 * round trip. Its own toolkit each time — `connections` allows only one live
 * row per (actor, toolkit), and one test's row settling to 'active' must not
 * collide with the next test's fresh 'connecting' one.
 */
async function connectingRow(actorId: string): Promise<string> {
  const toolkit = `fail${ulid('t').slice(-8).toLowerCase()}`;
  toolkits.push(toolkit);
  await db.insertInto('toolkits').values({
    slug: toolkit, name: 'Fail', description: '', logo_url: null, auth_scheme: 'OAUTH2',
    auth_config_id: `ac_${toolkit}`, auth_managed_by: 'composio', auth_guide_url: null, enabled: true, refreshed_at: sql`now()`,
  }).execute();
  const id = ulid('con');
  await db.insertInto('connections').values({
    id, workspace_id: wsp, actor_id: actorId, toolkit,
    composio_account_id: `ca_${id}`, status: 'connecting',
  }).execute();
  return id;
}

test('a connecting row is marked failed — the fact a local timeout has nowhere else to report', opts, async () => {
  const app = await server();
  const id = await connectingRow(alice);

  const res = await app.inject({ method: 'POST', url: `/connections/${id}/fail`, headers: as(alice) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { connection_id: id, status: 'failed' });

  const row = await db.selectFrom('connections').select(['status', 'status_reason']).where('id', '=', id).executeTakeFirst();
  assert.deepEqual(row, { status: 'failed', status_reason: 'failed' });
});

test('idempotent: a second call, or one that arrives after the row already settled, changes nothing', opts, async () => {
  const app = await server();
  const id = await connectingRow(alice);

  await app.inject({ method: 'POST', url: `/connections/${id}/fail`, headers: as(alice) });
  const second = await app.inject({ method: 'POST', url: `/connections/${id}/fail`, headers: as(alice) });
  assert.deepEqual(second.json(), { connection_id: id, status: 'failed' });

  // A slow local timeout firing after Composio's own redirect already
  // completed the row must not un-succeed it.
  await db.updateTable('connections').set({ status: 'active', status_reason: null }).where('id', '=', id).execute();
  const afterActive = await app.inject({ method: 'POST', url: `/connections/${id}/fail`, headers: as(alice) });
  assert.deepEqual(afterActive.json(), { connection_id: id, status: 'active' });
  const row = await db.selectFrom('connections').select('status').where('id', '=', id).executeTakeFirst();
  assert.equal(row?.status, 'active');
});

test('only the actor who started the attempt may fail it', opts, async () => {
  const app = await server();
  const id = await connectingRow(alice);

  const res = await app.inject({ method: 'POST', url: `/connections/${id}/fail`, headers: as(bob) });
  assert.equal(res.statusCode, 403);
  const row = await db.selectFrom('connections').select('status').where('id', '=', id).executeTakeFirst();
  assert.equal(row?.status, 'connecting', 'unchanged by the refused caller');
});

test('an unknown id is 404, and no bearer is 401', opts, async () => {
  const app = await server();
  assert.equal((await app.inject({ method: 'POST', url: `/connections/${ulid('con')}/fail`, headers: as(alice) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/connections/${ulid('con')}/fail` })).statusCode, 401);
});
