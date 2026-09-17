// Starting a side chat in a synced room (docs/SIDE-CHATS.md), through the route
// a client calls: what it writes, who hears about it, and what it refuses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import type { AppendedEvent } from './events.ts';
import { createChannel, createRoom, addToSpace, leaveSpace } from './spaces.ts';
import { spaceRoutes } from './routes.ts';
import { roomPanels } from './panels.ts';
import { welcome } from './feed.ts';
import { mentionedActorIds } from './mentions.ts';
import { provisionSystemAgents } from '../provisioning/system-agents.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const workspaceId = ulid('wsp');
const alice = ulid('act');
const bob = ulid('act');
const carol = ulid('act');
const dave = ulid('act');
let roomId = '';
let channelId = '';

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Side chats' }).execute();
  await db.insertInto('workspaces').values({
    id: workspaceId, org_id: org, name: 'Side chats', slug: `sc-${workspaceId.slice(-8).toLowerCase()}`,
  }).execute();
  for (const [actorId, name] of [[alice, 'Alice'], [bob, 'Bob'], [carol, 'Carol'], [dave, 'Dave']] as const) {
    await db.insertInto('actors').values({
      id: actorId, org_id: org, workspace_id: workspaceId, type: 'human',
      handle: `sc-${actorId.slice(-8).toLowerCase()}`, display_name: name,
      avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${actorId}`,
      owner_actor_id: null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({
      scope_type: 'workspace', scope_id: workspaceId, actor_id: actorId, role: 'member',
    }).execute();
  }
  await provisionSystemAgents(db, workspaceId);
  roomId = (await createRoom(db, { workspaceId, name: 'Flaky test', createdBy: alice })).spaceId;
  await addToSpace(db, roomId, bob, alice, ulid('msg'));
  await addToSpace(db, roomId, dave, alice, ulid('msg'));
  await leaveSpace(db, roomId, dave);
  channelId = (await createChannel(db, { workspaceId, name: 'Not a room', createdBy: alice })).spaceId;
  await addToSpace(db, channelId, bob, alice, ulid('msg'));
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
      return [alice, bob, carol, dave].includes(actorId)
        ? { actorId, workspaceId, orgId: org, workosUserId: null } : null;
    },
  }));
  return { app, delivered };
}

const as = (actorId: string) => ({ authorization: `Bearer ${actorId}` });
const ids = () => ({ chat_id: ulid('cht'), panel_id: ulid('pnl'), message_id: ulid('msg') });
const start = (app: Awaited<ReturnType<typeof server>>['app'], actorId: string, spaceId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/spaces/${spaceId}/chats`, headers: as(actorId), payload });

test('a public side chat is the chat, its panel and a first row naming who it is with — once', opts, async () => {
  const { app, delivered } = await server();
  const made = ids();
  const first = await start(app, alice, roomId, { ...made, name: '  Flaky login  ', kind: 'public', with_actor_ids: [bob] });
  assert.equal(first.statusCode, 201);
  assert.deepEqual(first.json(), { space_id: roomId, chat_id: made.chat_id, panel_id: made.panel_id, created: true });
  assert.deepEqual(delivered.map(event => event.type), ['chat.created', 'panel.opened', 'message.created'],
    'the chat before its panel and its first row');

  const chat = await db.selectFrom('chats').select(['kind', 'name', 'space_id']).where('id', '=', made.chat_id).executeTakeFirstOrThrow();
  assert.deepEqual({ ...chat }, { kind: 'public', name: 'Flaky login', space_id: roomId });

  const row = await db.selectFrom('messages')
    .select(['body', 'message_kind', 'system_kind', 'subject_actor_id', 'author_id'])
    .where('id', '=', made.message_id).executeTakeFirstOrThrow();
  assert.equal(row.body, `Alice started this with [Bob](actor-ref:${bob})`);
  assert.deepEqual([row.message_kind, row.system_kind, row.subject_actor_id, row.author_id],
    ['system', 'chat.started', alice, alice]);
  assert.deepEqual(mentionedActorIds(row.body), [], 'the people are named, not notified');

  const again = await start(app, alice, roomId, { ...made, name: 'Flaky login', kind: 'public', with_actor_ids: [bob] });
  assert.deepEqual([again.statusCode, again.json().created], [200, false], 'a retry is the same chat');
  assert.equal(delivered.length, 3, 'and delivers nothing new');
  await app.close();
});

test('everyone in the room gets the chat and its panel with the room', opts, async () => {
  const { app } = await server();
  const made = ids();
  await start(app, alice, roomId, { ...made, name: 'For everyone', kind: 'public', with_actor_ids: [bob] });

  const panel = (await roomPanels(db, [roomId])).find(row => row.id === made.panel_id);
  assert.deepEqual([panel?.type, panel?.chat_id], ['chat', made.chat_id]);
  const bobs = await welcome(db, workspaceId, bob);
  assert.ok(bobs.chats.some(row => row.chatId === made.chat_id), 'a public side chat is every member\'s');
  assert.ok(bobs.panels.some(row => row.id === made.panel_id));
  await app.close();
});

test('a side chat needs a name and somebody in the room to start it with', opts, async () => {
  const { app } = await server();
  const refused = async (actorId: string, spaceId: string, payload: Record<string, unknown>) => {
    const answer = await start(app, actorId, spaceId, { ...ids(), name: 'Chat', kind: 'public', with_actor_ids: [bob], ...payload });
    return [answer.statusCode, answer.json()];
  };

  assert.deepEqual(await refused(alice, roomId, { with_actor_ids: [alice] }),
    [400, { error: 'invalid', field: 'with_actor_ids', reason: 'nobody', max: 80 }], 'yourself is nobody');
  assert.deepEqual(await refused(alice, roomId, { name: '   ' }),
    [400, { error: 'invalid', field: 'name', reason: 'required', max: 80 }]);
  assert.deepEqual(await refused(alice, roomId, { name: 'x'.repeat(81) }),
    [400, { error: 'invalid', field: 'name', reason: 'too_long', max: 80 }]);
  assert.deepEqual((await refused(alice, roomId, { with_actor_ids: [carol] }))[0], 404, 'not in the room');
  assert.deepEqual((await refused(alice, roomId, { with_actor_ids: [dave] }))[0], 404, 'left the room');
  assert.deepEqual(await refused(alice, roomId, { kind: 'private' }),
    [400, { error: 'invalid', field: 'kind', reason: 'not_supported' }], 'private is not built yet');
  assert.deepEqual(await refused(alice, channelId, {}), [400, { error: 'not_a_room' }]);
  assert.deepEqual((await refused(carol, roomId, { with_actor_ids: [alice] }))[0], 403, 'only somebody in the room');
  assert.deepEqual((await refused(alice, roomId, { chat_id: 'nope' }))[0], 400, 'an id the client made, in its shape');
  await app.close();
});

test('a chat id already taken by something else is a conflict, not a retry', opts, async () => {
  const { app } = await server();
  const made = ids();
  await start(app, alice, roomId, { ...made, name: 'Mine', kind: 'public', with_actor_ids: [bob] });
  const theirs = await start(app, bob, roomId, { ...ids(), chat_id: made.chat_id, name: 'Theirs', kind: 'public', with_actor_ids: [alice] });
  assert.deepEqual([theirs.statusCode, theirs.json()], [409, { error: 'conflict', field: 'chat_id' }]);
  await app.close();
});
