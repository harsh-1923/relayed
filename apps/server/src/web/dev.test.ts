// The dev route that writes a restricted message by hand (WORKSPACE-AGENTS.md §12.2, step 1),
// through Fastify's `inject` — no listener, no socket, the real writer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { createChannel, addToSpace } from '../sync/spaces.ts';
import type { AppendedEvent } from '../sync/events.ts';
import { devRoutes } from './dev.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const me = ulid('act');
const bob = ulid('act');
const outsider = ulid('act');

before(async () => {
  if (!up) return;
  await db.insertInto('organizations')
    .values({ id: org, workos_org_id: `test_${org}`, name: 'Dev' }).execute();
  await db.insertInto('workspaces')
    .values({ id: wsp, org_id: org, name: 'Dev', slug: `d-${wsp.slice(-6).toLowerCase()}` })
    .execute();
  for (const id of [me, bob, outsider]) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type: 'human',
      handle: `d-${id.slice(-6).toLowerCase()}`, display_name: 'Dev Test',
      avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${id}`,
      owner_actor_id: null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({
      scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member',
    }).execute();
  }
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

async function server() {
  const delivered: AppendedEvent[] = [];
  const app = Fastify();
  await app.register(devRoutes({
    db,
    deliver: async (event) => {
      delivered.push(event);
      return { audience: 0, delivered: 0, dropped: 0, withheld: 0 };
    },
  }));
  const { spaceId, chatId } = await createChannel(db, {
    workspaceId: wsp, name: `d-${ulid('x')}`, createdBy: me });
  await addToSpace(db, spaceId, bob, me);
  return { app, delivered, chatId };
}

const post = (app: Awaited<ReturnType<typeof server>>['app'], payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/dev/restricted-message', payload });

test('writes a message for the listed, and delivers it after the commit', opts, async () => {
  const { app, delivered, chatId } = await server();
  const res = await post(app, { chatId, authorId: me, listed: [bob], body: 'connect Linear' });

  assert.equal(res.statusCode, 200, res.body);
  const { id } = res.json<{ id: string }>();
  const row = await db.selectFrom('messages').select('visible_to')
    .where('id', '=', id).executeTakeFirstOrThrow();
  assert.deepEqual(row.visible_to, [bob]);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0]?.audience, { kind: 'listed', actors: [bob] });
  await app.close();
});

test('refuses a listed actor who cannot read the chat, and delivers nothing', opts, async () => {
  const { app, delivered, chatId } = await server();
  const res = await post(app, { chatId, authorId: me, listed: [outsider], body: 'x' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'audience_cannot_read', actor_id: outsider });
  assert.equal(delivered.length, 0);
  await app.close();
});

test('refuses an empty list, an author who cannot post, and a malformed body', opts, async () => {
  const { app, chatId } = await server();
  assert.equal((await post(app, { chatId, authorId: me, listed: [], body: 'x' })).statusCode, 400);
  assert.equal((await post(app, { chatId, authorId: outsider, listed: [me], body: 'x' })).statusCode, 403);
  assert.equal((await post(app, { chatId, authorId: me, listed: 'everyone', body: 'x' })).statusCode, 400);
  await app.close();
});

test('agent-message writes an agent\'s parts with a derived body, and refuses a person\'s ui part', opts, async () => {
  const { app, delivered, chatId } = await server();
  const agentId = ulid('act');
  const org_ = (await db.selectFrom('workspaces').select('org_id').where('id', '=', wsp).executeTakeFirstOrThrow()).org_id;
  await db.insertInto('actors').values({
    id: agentId, org_id: org_, workspace_id: wsp, type: 'agent', handle: `d-${agentId.slice(-8).toLowerCase()}`,
    display_name: 'Agent', avatar_url: null, identity_kind: 'system', identity_id: null,
    owner_actor_id: me, provisioned_by: 'api', state: 'active' }).execute();
  await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: agentId, role: 'member' }).execute();
  const space = (await db.selectFrom('chats').select('space_id').where('id', '=', chatId).executeTakeFirstOrThrow()).space_id;
  await db.insertInto('memberships').values({ scope_type: 'space', scope_id: space, actor_id: agentId, role: 'member' }).execute();

  const ui = { kind: 'ui', lang: 'openui-lang@0.5', library: 'relayed-ui@1',
               source: 'root = Card([h])\nh = CardHeader("Deploy finished", "3 services")' };
  const ok = await app.inject({ method: 'POST', url: '/dev/agent-message',
    payload: { chatId, authorId: agentId, parts: [{ kind: 'markdown', text: 'Done.' }, ui] } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((delivered.at(-1)?.payload as { body: string }).body, 'Done.\n\nDeploy finished: 3 services');

  const refused = await app.inject({ method: 'POST', url: '/dev/agent-message', payload: { chatId, authorId: me, parts: [ui] } });
  assert.deepEqual([refused.statusCode, refused.json()], [400, { error: 'parts_refused', reason: 'forbidden_kind', detail: 'ui' }]);
  await app.close();
});
