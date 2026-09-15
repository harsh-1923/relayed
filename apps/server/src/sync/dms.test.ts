// Opening a DM or group DM (DESIGN.md §7.1): the one already there, or a new
// one — against Postgres, and through the route.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import type { AppendedEvent } from './events.ts';
import { openDm, leaveSpace, addToSpace, dmKey, DM_MAX_MEMBERS, InvalidDmMembersError, SealedSpaceError, SpaceMemberUnavailableError } from './spaces.ts';
import { spaceRoutes } from './routes.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const workspaceId = ulid('wsp');
const people = Array.from({ length: 10 }, () => ulid('act'));
const [alice, bob, carol, dave] = people as [string, string, string, string];
const agent = ulid('act');
const gone = ulid('act');
const elsewhere = ulid('act');

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'DMs' }).execute();
  await db.insertInto('workspaces').values({ id: workspaceId, org_id: org, name: 'DMs', slug: `dm-${workspaceId.slice(-8).toLowerCase()}` }).execute();
  const other = ulid('wsp');
  await db.insertInto('workspaces').values({ id: other, org_id: org, name: 'Other', slug: `dmo-${other.slice(-8).toLowerCase()}` }).execute();
  const actor = (id: string, type: 'human' | 'agent', state: 'active' | 'deactivated', ws: string) => db.insertInto('actors').values({
    id, org_id: org, workspace_id: ws, type, handle: `dm-${id.slice(-8).toLowerCase()}`, display_name: 'Person',
    avatar_url: null, identity_kind: type === 'agent' ? 'system' : 'workos_user', identity_id: type === 'agent' ? null : `wu_${id}`,
    owner_actor_id: type === 'agent' ? alice : null, provisioned_by: 'api', state,
  }).execute();
  for (const id of people) await actor(id, 'human', 'active', workspaceId);
  await actor(agent, 'agent', 'active', workspaceId);
  await actor(gone, 'human', 'deactivated', workspaceId);
  await actor(elsewhere, 'human', 'active', other);
  for (const id of [...people, agent, gone]) {
    await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: workspaceId, actor_id: id, role: 'member' }).execute();
  }
  await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: other, actor_id: elsewhere, role: 'member' }).execute();
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('sync_events').where('workspace_id', '=', workspaceId).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', workspaceId).execute();
  await db.deleteFrom('memberships').where('actor_id', 'in', [...people, agent, gone, elsewhere]).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

const membersOf = async (spaceId: string) => (await db.selectFrom('memberships').select(['actor_id', 'role', 'left_at'])
  .where('scope_type', '=', 'space').where('scope_id', '=', spaceId).execute())
  .map(row => ({ actor_id: row.actor_id, role: row.role, live: row.left_at === null }))
  .sort((a, b) => a.actor_id.localeCompare(b.actor_id));

test('a DM between two people is created once, and opened by either of them after that', opts, async () => {
  const first = await openDm(db, { workspaceId, openedBy: alice, withActorIds: [bob] });
  assert.equal(first.created, true);
  const space = await db.selectFrom('spaces').select(['kind', 'name', 'visibility', 'membership_policy', 'dm_key', 'created_by_actor_id'])
    .where('id', '=', first.spaceId).executeTakeFirstOrThrow();
  assert.deepEqual(space, {
    kind: 'dm', name: null, visibility: null, membership_policy: 'sealed', dm_key: dmKey([alice, bob]), created_by_actor_id: alice,
  });
  assert.deepEqual(await membersOf(first.spaceId), [alice, bob].sort().map(id => ({ actor_id: id, role: 'member', live: true })));
  // Each person gets their own member_added, so each of their devices hydrates it; no marker message.
  assert.deepEqual(first.events.map(event => event.type), ['space.created', 'chat.created', 'space.member_added', 'space.member_added']);
  assert.deepEqual(first.events.slice(2).map(event => (event.payload as { actor_id: string }).actor_id), [alice, bob]);
  const created = first.events[0]!.payload as { member_ids: string[] };
  assert.deepEqual(created.member_ids, [alice, bob].sort());

  const again = await openDm(db, { workspaceId, openedBy: bob, withActorIds: [alice, alice] });
  assert.deepEqual([again.created, again.spaceId, again.chatId, again.events], [false, first.spaceId, first.chatId, []]);
});

test('three or more people are a group DM, a different conversation from any DM inside it', opts, async () => {
  const dm = await openDm(db, { workspaceId, openedBy: carol, withActorIds: [dave] });
  const group = await openDm(db, { workspaceId, openedBy: carol, withActorIds: [dave, alice] });
  assert.notEqual(group.spaceId, dm.spaceId);
  assert.equal((await db.selectFrom('spaces').select('kind').where('id', '=', group.spaceId).executeTakeFirstOrThrow()).kind, 'group_dm');
  const reordered = await openDm(db, { workspaceId, openedBy: alice, withActorIds: [dave, carol] });
  assert.deepEqual([reordered.created, reordered.spaceId], [false, group.spaceId], 'the same people, in any order, by any of them');
});

test('nobody is added to one: a DM is sealed', opts, async () => {
  const dm = await openDm(db, { workspaceId, openedBy: bob, withActorIds: [carol] });
  await assert.rejects(() => addToSpace(db, dm.spaceId, dave, bob, ulid('msg')), SealedSpaceError);
});

test('opening one you left brings you back — and nobody else who left', opts, async () => {
  const group = await openDm(db, { workspaceId, openedBy: alice, withActorIds: [bob, dave] });
  await leaveSpace(db, group.spaceId, alice);
  await leaveSpace(db, group.spaceId, dave);

  const reopened = await openDm(db, { workspaceId, openedBy: alice, withActorIds: [dave, bob] });
  assert.deepEqual([reopened.created, reopened.spaceId], [false, group.spaceId]);
  assert.deepEqual(reopened.events.map(event => [event.type, (event.payload as { actor_id: string }).actor_id]), [['space.member_added', alice]]);
  const live = (await membersOf(group.spaceId)).filter(row => row.live).map(row => row.actor_id).sort();
  assert.deepEqual(live, [alice, bob].sort());
});

test('two people opening the same conversation at once land in one', opts, async () => {
  const [one, two] = await Promise.all([
    openDm(db, { workspaceId, openedBy: people[4]!, withActorIds: [people[5]!] }),
    openDm(db, { workspaceId, openedBy: people[5]!, withActorIds: [people[4]!] }),
  ]);
  assert.equal(one.spaceId, two.spaceId);
  assert.deepEqual([one.created, two.created].sort(), [false, true]);
  const rows = await db.selectFrom('spaces').select('id').where('dm_key', '=', dmKey([people[4]!, people[5]!])).execute();
  assert.equal(rows.length, 1);
});

test('who may be in one: someone else, at most nine people, active members of this workspace — an agent included', opts, async () => {
  await assert.rejects(() => openDm(db, { workspaceId, openedBy: alice, withActorIds: [] }), (err: unknown) => err instanceof InvalidDmMembersError && err.reason === 'nobody');
  await assert.rejects(() => openDm(db, { workspaceId, openedBy: alice, withActorIds: [alice] }), InvalidDmMembersError);
  assert.equal(DM_MAX_MEMBERS, 9);
  await assert.rejects(() => openDm(db, { workspaceId, openedBy: alice, withActorIds: people.slice(1) }),
    (err: unknown) => err instanceof InvalidDmMembersError && err.reason === 'too_many');
  const nine = await openDm(db, { workspaceId, openedBy: alice, withActorIds: people.slice(1, 9) });
  assert.equal(nine.created, true);

  await assert.rejects(() => openDm(db, { workspaceId, openedBy: alice, withActorIds: [gone] }), SpaceMemberUnavailableError);
  await assert.rejects(() => openDm(db, { workspaceId, openedBy: alice, withActorIds: [elsewhere] }), SpaceMemberUnavailableError);
  const before = await db.selectFrom('spaces').select('id').where('workspace_id', '=', workspaceId).execute();
  await assert.rejects(() => openDm(db, { workspaceId, openedBy: alice, withActorIds: [bob, gone] }), SpaceMemberUnavailableError);
  assert.equal((await db.selectFrom('spaces').select('id').where('workspace_id', '=', workspaceId).execute()).length, before.length);

  assert.equal((await openDm(db, { workspaceId, openedBy: alice, withActorIds: [agent] })).created, true);
});

// ── the route ───────────────────────────────────────────────────────────────

async function server() {
  const delivered: AppendedEvent[] = [];
  const app = Fastify();
  await app.register(spaceRoutes({
    db,
    deliver: async event => { delivered.push(event); return { audience: 0, delivered: 0, dropped: 0, withheld: 0 }; },
    caller: async authorization => {
      const actorId = (authorization ?? '').replace(/^Bearer /, '');
      return people.includes(actorId) ? { actorId, workspaceId, orgId: org, workosUserId: null } : null;
    },
  }));
  return { app, delivered };
}

const as = (actorId: string) => ({ authorization: `Bearer ${actorId}` });

test('POST /dms: 201 when made, 200 when it existed, every event delivered, and the caller is always in it', opts, async () => {
  const { app, delivered } = await server();
  const payload = { workspace_id: workspaceId, actor_ids: [people[7]!] };
  const made = await app.inject({ method: 'POST', url: '/dms', headers: as(people[6]!), payload });
  assert.equal(made.statusCode, 201);
  const body = made.json<{ space_id: string; chat_id: string; created: boolean }>();
  assert.equal(body.created, true);
  assert.deepEqual(delivered.map(event => event.type), ['space.created', 'chat.created', 'space.member_added', 'space.member_added']);

  const opened = await app.inject({ method: 'POST', url: '/dms', headers: as(people[7]!), payload: { workspace_id: workspaceId, actor_ids: [people[6]!] } });
  assert.equal(opened.statusCode, 200);
  assert.deepEqual(opened.json(), { ...body, created: false });
  await app.close();
});

test('POST /dms refuses: no caller, another workspace, bad ids, nobody, too many, someone unreachable', opts, async () => {
  const { app, delivered } = await server();
  const post = (headers: Record<string, string>, payload: unknown) => app.inject({ method: 'POST', url: '/dms', headers, payload: payload as Record<string, unknown> });
  assert.equal((await post({}, { workspace_id: workspaceId, actor_ids: [bob] })).statusCode, 401);
  assert.equal((await post(as(alice), { workspace_id: 'wsp_other', actor_ids: [bob] })).statusCode, 403);
  assert.deepEqual((await post(as(alice), { workspace_id: workspaceId, actor_ids: 'bob' })).json(), { error: 'invalid', field: 'actor_ids' });
  assert.deepEqual((await post(as(alice), { workspace_id: workspaceId, actor_ids: [''] })).json(), { error: 'invalid', field: 'actor_ids' });
  assert.equal((await post(as(alice), { workspace_id: workspaceId, actor_ids: [] })).json<{ reason: string }>().reason, 'nobody');
  assert.equal((await post(as(alice), { workspace_id: workspaceId, actor_ids: people })).json<{ reason: string }>().reason, 'too_many');
  const unreachable = await post(as(alice), { workspace_id: workspaceId, actor_ids: [gone] });
  assert.deepEqual([unreachable.statusCode, unreachable.json()], [404, { error: 'actor_unavailable', field: 'actor_id' }]);
  assert.deepEqual(delivered, []);
  await app.close();
});
