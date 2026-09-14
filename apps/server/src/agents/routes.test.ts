// The agent routes, through Fastify's `inject`: status codes and the field a
// refusal names, which is what the editor draws. The rules themselves are
// tested in definitions.test.ts; this is the HTTPS skin over them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import type { AppendedEvent } from '../sync/events.ts';
import { Registry } from '../sync/registry.ts';
import { agentRoutes } from './routes.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const alice = ulid('act');
const bob = ulid('act');

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Routes' }).execute();
  await db.insertInto('workspaces').values({ id: wsp, org_id: org, name: 'Routes', slug: `r-${wsp.slice(-8).toLowerCase()}` }).execute();
  for (const id of [alice, bob]) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type: 'human', handle: `r-${id.slice(-8).toLowerCase()}`,
      display_name: 'Person', avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${id}`,
      owner_actor_id: null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member' }).execute();
  }
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

async function server() {
  const delivered: AppendedEvent[] = [];
  const app = Fastify();
  await app.register(agentRoutes({
    db,
    deliver: async (event) => { delivered.push(event); return { audience: 0, delivered: 0, dropped: 0, withheld: 0 }; },
    registry: new Registry(),
    // `Bearer <actor id>` stands in for a signed token.
    caller: async (authorization) => {
      const actorId = (authorization ?? '').replace(/^Bearer /, '');
      return [alice, bob].includes(actorId)
        ? { actorId, workspaceId: wsp, orgId: org, workosUserId: null } : null;
    },
  }));
  return { app, delivered };
}

const as = (actorId: string) => ({ authorization: `Bearer ${actorId}` });
const handle = () => `r-${ulid('h').slice(-8).toLowerCase()}`;

test('no caller, no agent routes', opts, async () => {
  const { app } = await server();
  assert.equal((await app.inject({ method: 'POST', url: '/agents', payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/agents/handles/triage' })).statusCode, 401);
  await app.close();
});

test('create answers 201 with the id, and DELIVERS the directory event after commit', opts, async () => {
  const { app, delivered } = await server();
  const h = handle();
  const res = await app.inject({ method: 'POST', url: '/agents', headers: as(alice),
    payload: { name: 'Triage', handle: h, instructions: 'File bugs.', description: 'Bugs' } });
  assert.equal(res.statusCode, 201, res.body);
  const { agent_id: agentId } = res.json<{ agent_id: string }>();
  assert.deepEqual(delivered.map(e => e.type), ['actor.created']);

  const again = await app.inject({ method: 'POST', url: '/agents', headers: as(bob),
    payload: { name: 'Clash', handle: h, instructions: 'x' } });
  assert.equal(again.statusCode, 409);
  assert.deepEqual(again.json(), { error: 'handle_taken', field: 'handle' });

  const check = await app.inject({ method: 'GET', url: `/agents/handles/${h}?except=${agentId}`, headers: as(alice) });
  assert.deepEqual(check.json(), { handle: h, available: true, reason: null }, 'its own handle, while editing it');
  await app.close();
});

test('a refusal names the FIELD, so the editor can put it beside it', opts, async () => {
  const { app } = await server();
  const missing = await app.inject({ method: 'POST', url: '/agents', headers: as(alice),
    payload: { name: 'Triage', handle: handle() } });
  assert.deepEqual([missing.statusCode, missing.json()], [400, { error: 'invalid', field: 'instructions', reason: 'required' }]);

  const reserved = await app.inject({ method: 'POST', url: '/agents', headers: as(alice),
    payload: { name: 'X', handle: 'everyone', instructions: 'x' } });
  assert.deepEqual(reserved.json(), { error: 'invalid', field: 'handle', reason: 'reserved' });

  const model = await app.inject({ method: 'POST', url: '/agents', headers: as(alice),
    payload: { name: 'X', handle: handle(), instructions: 'x', model: 42 } });
  assert.deepEqual(model.json(), { error: 'invalid', field: 'model', reason: 'not_a_string' });
  await app.close();
});

test('edit: 403 for another member, 200 for the maintainer; deactivate, then 409 on edit', opts, async () => {
  const { app, delivered } = await server();
  const created = await app.inject({ method: 'POST', url: '/agents', headers: as(alice),
    payload: { name: 'Triage', handle: handle(), instructions: 'File bugs.' } });
  const { agent_id: agentId } = created.json<{ agent_id: string }>();

  const bobs = await app.inject({ method: 'PATCH', url: `/agents/${agentId}`, headers: as(bob), payload: { name: 'Mine' } });
  assert.deepEqual([bobs.statusCode, bobs.json()], [403, { error: 'forbidden', action: 'edit' }]);

  const mine = await app.inject({ method: 'PATCH', url: `/agents/${agentId}`, headers: as(alice), payload: { description: 'Better' } });
  assert.equal(mine.statusCode, 200, mine.body);
  assert.equal(delivered.at(-1)?.type, 'actor.updated');

  assert.equal((await app.inject({ method: 'POST', url: `/agents/${agentId}/deactivate`, headers: as(alice) })).statusCode, 200);
  const late = await app.inject({ method: 'PATCH', url: `/agents/${agentId}`, headers: as(alice), payload: { name: 'Back' } });
  assert.deepEqual([late.statusCode, late.json()], [409, { error: 'agent_deactivated' }]);

  assert.equal((await app.inject({ method: 'PATCH', url: `/agents/${ulid('act')}`, headers: as(alice), payload: {} })).statusCode, 404);
  await app.close();
});

test('maintainers: replaced by the maintainer, refused empty', opts, async () => {
  const { app } = await server();
  const created = await app.inject({ method: 'POST', url: '/agents', headers: as(alice),
    payload: { name: 'Triage', handle: handle(), instructions: 'File bugs.' } });
  const { agent_id: agentId } = created.json<{ agent_id: string }>();

  const empty = await app.inject({ method: 'PUT', url: `/agents/${agentId}/maintainers`, headers: as(alice), payload: { actor_ids: [] } });
  assert.deepEqual(empty.json(), { error: 'invalid', field: 'actor_ids', reason: 'required' });
  const set = await app.inject({ method: 'PUT', url: `/agents/${agentId}/maintainers`, headers: as(alice), payload: { actor_ids: [alice, bob] } });
  assert.deepEqual(set.json(), { agent_id: agentId, maintainers: [alice, bob].sort() });
  await app.close();
});
