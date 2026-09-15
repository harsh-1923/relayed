// The HTTPS skin over adding an actor to a space. The domain tests own the
// complete ACL matrix; these prove identity, input, refusal and delivery.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import type { AppendedEvent } from './events.ts';
import { createChannel, addToSpace, spaceMembers } from './spaces.ts';
import { spaceRoutes } from './routes.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const workspaceId = ulid('wsp');
const alice = ulid('act');
const bob = ulid('act');
const carol = ulid('act');
let spaceId = '';

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Space routes' }).execute();
  await db.insertInto('workspaces').values({
    id: workspaceId, org_id: org, name: 'Space routes', slug: `sr-${workspaceId.slice(-8).toLowerCase()}`,
  }).execute();
  for (const actorId of [alice, bob, carol]) {
    await db.insertInto('actors').values({
      id: actorId, org_id: org, workspace_id: workspaceId, type: 'human',
      handle: `sr-${actorId.slice(-8).toLowerCase()}`, display_name: 'Person',
      avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${actorId}`,
      owner_actor_id: null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({
      scope_type: 'workspace', scope_id: workspaceId, actor_id: actorId, role: 'member',
    }).execute();
  }
  const channel = await createChannel(db, { workspaceId, name: 'Route', createdBy: alice });
  spaceId = channel.spaceId;
  await addToSpace(db, spaceId, bob, alice, ulid('msg'));
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('spaces').where('workspace_id', '=', workspaceId).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', workspaceId).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

async function server() {
  const delivered: AppendedEvent[] = [];
  const app = Fastify();
  await app.register(spaceRoutes({
    db,
    deliver: async event => {
      delivered.push(event);
      return { audience: 0, delivered: 0, dropped: 0, withheld: 0 };
    },
    caller: async authorization => {
      const actorId = (authorization ?? '').replace(/^Bearer /, '');
      return [alice, bob, carol].includes(actorId)
        ? { actorId, workspaceId, orgId: org, workosUserId: null } : null;
    },
  }));
  return { app, delivered };
}

const as = (actorId: string) => ({ authorization: `Bearer ${actorId}` });

test('adding needs an authenticated caller, an actor id, and a message id', opts, async () => {
  const { app } = await server();
  assert.equal((await app.inject({ method: 'POST', url: `/spaces/${spaceId}/members`, payload: {} })).statusCode, 401);
  const missingActor = await app.inject({
    method: 'POST', url: `/spaces/${spaceId}/members`, headers: as(alice), payload: {},
  });
  assert.deepEqual([missingActor.statusCode, missingActor.json()],
    [400, { error: 'invalid', field: 'actor_id', reason: 'required' }]);
  const missingMessage = await app.inject({
    method: 'POST', url: `/spaces/${spaceId}/members`, headers: as(alice), payload: { actor_id: carol },
  });
  assert.deepEqual([missingMessage.statusCode, missingMessage.json()],
    [400, { error: 'invalid', field: 'message_id', reason: 'required' }]);
  await app.close();
});

test('the route preserves the domain authorization and target checks', opts, async () => {
  const { app, delivered } = await server();
  const forbidden = await app.inject({
    method: 'POST', url: `/spaces/${spaceId}/members`, headers: as(carol),
    payload: { actor_id: bob, message_id: ulid('msg') },
  });
  assert.deepEqual([forbidden.statusCode, forbidden.json()],
    [403, { error: 'forbidden', action: 'add_member' }]);

  const unavailable = await app.inject({
    method: 'POST', url: `/spaces/${spaceId}/members`, headers: as(alice),
    payload: { actor_id: ulid('act'), message_id: ulid('msg') },
  });
  assert.deepEqual([unavailable.statusCode, unavailable.json()],
    [404, { error: 'actor_unavailable', field: 'actor_id' }]);
  assert.deepEqual(delivered, []);
  await app.close();
});

test('a member adds an actor and both the membership and its marker are delivered', opts, async () => {
  const { app, delivered } = await server();
  const messageId = ulid('msg');
  const response = await app.inject({
    method: 'POST', url: `/spaces/${spaceId}/members`, headers: as(bob),
    payload: { actor_id: carol, message_id: messageId },
  });
  assert.deepEqual([response.statusCode, response.json()],
    [200, { space_id: spaceId, actor_id: carol, message_id: messageId }]);
  assert.deepEqual(delivered.map(event => event.type), ['space.member_added', 'message.created']);
  assert.ok((await spaceMembers(db, spaceId)).includes(carol));
  await app.close();
});

test('adding an already-active member is a clean no-op, not a second marker', opts, async () => {
  const { app, delivered } = await server();
  const response = await app.inject({
    method: 'POST', url: `/spaces/${spaceId}/members`, headers: as(alice),
    payload: { actor_id: bob, message_id: ulid('msg') },
  });
  assert.deepEqual([response.statusCode, response.json()],
    [409, { error: 'already_member', space_id: spaceId, actor_id: bob }]);
  assert.deepEqual(delivered, []);
  await app.close();
});

test('a sealed space refuses the add', opts, async () => {
  const { app } = await server();
  const sealedId = ulid('spc');
  const sealedChatId = ulid('cht');
  await db.insertInto('spaces').values({
    id: sealedId, org_id: org, workspace_id: workspaceId, kind: 'dm', name: null,
    slug: null, topic: null, visibility: null, membership_policy: 'sealed',
    created_by_actor_id: alice,
  }).execute();
  await db.insertInto('chats').values({
    id: sealedChatId, workspace_id: workspaceId, space_id: sealedId, kind: 'sole',
    name: null, created_by_actor_id: alice,
  }).execute();
  await db.insertInto('memberships').values({
    scope_type: 'space', scope_id: sealedId, actor_id: alice, role: 'admin',
  }).execute();

  const response = await app.inject({
    method: 'POST', url: `/spaces/${sealedId}/members`, headers: as(alice),
    payload: { actor_id: carol, message_id: ulid('msg') },
  });
  assert.deepEqual([response.statusCode, response.json()],
    [403, { error: 'sealed_space', space_id: sealedId }]);
  await app.close();
});

for (const kind of ['channel', 'room'] as const) {
  for (const visibility of ['public', 'private'] as const) {
    test(`creating a ${visibility} ${kind} commits its structural chat, admin and hydration`, opts, async () => {
      const { app, delivered } = await server();
      try {
        const response = await app.inject({
          method: 'POST', url: '/spaces', headers: as(alice),
          payload: { workspace_id: workspaceId, kind, name: '  Launch  ', visibility, created_by: bob },
        });
        assert.equal(response.statusCode, 201, response.body);
        const created = response.json<{ space_id: string; chat_id: string }>();
        const space = await db.selectFrom('spaces').selectAll().where('id', '=', created.space_id).executeTakeFirstOrThrow();
        assert.equal(space.kind, kind);
        assert.equal(space.name, 'Launch');
        assert.equal(space.org_id, org);
        assert.equal(space.visibility, visibility);
        assert.equal(space.membership_policy, visibility === 'public' ? 'open' : 'invite');
        assert.equal(space.slug, null);
        assert.equal(space.created_by_actor_id, alice, 'caller identity cannot be supplied in the body');
        const chats = await db.selectFrom('chats').selectAll().where('space_id', '=', created.space_id).execute();
        assert.equal(chats.length, 1);
        assert.equal(chats[0]?.id, created.chat_id);
        assert.equal(chats[0]?.kind, kind === 'channel' ? 'sole' : 'default');
        const members = await db.selectFrom('memberships').select(['actor_id', 'role'])
          .where('scope_type', '=', 'space').where('scope_id', '=', created.space_id).execute();
        assert.deepEqual(members, [{ actor_id: alice, role: 'admin' }]);
        assert.deepEqual(delivered.map(event => [event.rev, event.type]),
          [[1, 'space.created'], [2, 'chat.created'], [3, 'space.member_added']]);
        const founding = delivered[2]?.payload as { hydration: { space: { id: string; kind: string }; chats: { id: string; kind: string }[] } };
        assert.equal(founding.hydration.space.id, created.space_id);
        assert.equal(founding.hydration.space.kind, kind);
        assert.equal(founding.hydration.chats[0]?.id, created.chat_id);
      } finally {
        await app.close();
      }
    });
  }
}

test('creation rejects missing identity, a different workspace and invalid fields without delivery', opts, async () => {
  const { app, delivered } = await server();
  const input = { workspace_id: workspaceId, kind: 'room', name: 'Launch', visibility: 'private' };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/spaces', payload: input })).statusCode, 401);
    for (const change of [
      { workspace_id: ulid('wsp') }, { kind: 'dm' }, { name: '' }, { name: '   ' },
      { name: 123 }, { name: 'x'.repeat(101) }, { visibility: 'sealed' },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/spaces', headers: as(alice), payload: { ...input, ...change } });
      assert.equal(response.statusCode, 'workspace_id' in change ? 403 : 400, response.body);
    }
    assert.deepEqual(delivered, []);
  } finally {
    await app.close();
  }
});

test('creation rechecks workspace permission even for an authenticated caller', opts, async () => {
  const { app, delivered } = await server();
  await db.updateTable('memberships').set({ left_at: new Date() })
    .where('scope_type', '=', 'workspace').where('scope_id', '=', workspaceId).where('actor_id', '=', carol).execute();
  try {
    for (const kind of ['channel', 'room']) {
      const response = await app.inject({ method: 'POST', url: '/spaces', headers: as(carol),
        payload: { workspace_id: workspaceId, kind, name: 'Denied', visibility: 'public' } });
      assert.equal(response.statusCode, 403);
    }
    assert.deepEqual(delivered, []);
  } finally {
    await db.updateTable('memberships').set({ left_at: null })
      .where('scope_type', '=', 'workspace').where('scope_id', '=', workspaceId).where('actor_id', '=', carol).execute();
    await app.close();
  }
});
