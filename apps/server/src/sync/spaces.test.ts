// The marker feature's domain layer (docs/SPACE-MEMBERSHIP-MARKERS.md).
//
// `routes.test.ts` covers the HTTPS skin (auth, validation, refusal shapes);
// `feed.test.ts` and `definitions.test.ts` cover `spaces.ts`'s pre-existing
// permission matrix. This file is the atomic write itself: the marker body,
// idempotency with no side effects, the sealed refusal, and the hydration
// snapshot a newly-added actor's own replica needs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import {
  createChannel, addToSpace, leaveSpace, spaceMembers,
} from './spaces.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const workspaceId = ulid('wsp');
const alice = ulid('act');
const bob = ulid('act');

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Spaces' }).execute();
  await db.insertInto('workspaces').values({
    id: workspaceId, org_id: org, name: 'Spaces', slug: `sp-${workspaceId.slice(-8).toLowerCase()}`,
  }).execute();
  for (const [actorId, name] of [[alice, 'Alice'], [bob, 'Bob']] as const) {
    await db.insertInto('actors').values({
      id: actorId, org_id: org, workspace_id: workspaceId, type: 'human',
      handle: `sp-${actorId.slice(-8).toLowerCase()}`, display_name: name,
      avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${actorId}`,
      owner_actor_id: null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({
      scope_type: 'workspace', scope_id: workspaceId, actor_id: actorId, role: 'member',
    }).execute();
  }
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('spaces').where('workspace_id', '=', workspaceId).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', workspaceId).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

const channel = () => createChannel(db, { workspaceId, name: `s-${ulid('x')}`, createdBy: alice });

const messageRow = (messageId: string) =>
  db.selectFrom('messages').selectAll().where('id', '=', messageId).executeTakeFirst();

test('adding writes one membership event and one system marker, atomically', opts, async () => {
  const { spaceId, chatId } = await channel();
  const messageId = ulid('msg');
  const result = await addToSpace(db, spaceId, bob, alice, messageId);
  if (result.status !== 'added') throw new Error('expected the add to succeed');

  assert.equal(result.membershipEvent.type, 'space.member_added');
  assert.equal(result.messageEvent.type, 'message.created');
  assert.ok((await spaceMembers(db, spaceId)).includes(bob));

  const row = await messageRow(messageId);
  assert.ok(row, 'the marker lives in the structural chat');
  assert.equal(row?.chat_id, chatId);
  assert.equal(row?.message_kind, 'system');
  assert.equal(row?.system_kind, 'space.member_added');
  assert.equal(row?.subject_actor_id, bob);
  assert.equal(row?.author_id, alice, 'attribution: who ran the command, not who it reads as authored');
  assert.equal(row?.body, 'Bob was added by Alice');
  assert.equal(row?.visible_to, null, 'the whole chat, like any ordinary message');
});

test('the space event carries by_actor_id and a hydration snapshot', opts, async () => {
  const { spaceId, chatId } = await channel();
  const result = await addToSpace(db, spaceId, bob, alice, ulid('msg'));
  if (result.status !== 'added') throw new Error('expected the add to succeed');

  const payload = result.membershipEvent.payload as {
    actor_id: string; role: string; by_actor_id: string;
    hydration: { space: { id: string; rev: number }; chats: { id: string }[] };
  };
  assert.equal(payload.actor_id, bob);
  assert.equal(payload.by_actor_id, alice);
  assert.equal(payload.hydration.space.id, spaceId);
  assert.ok(payload.hydration.space.rev > 0);
  assert.deepEqual(payload.hydration.chats.map(c => c.id), [chatId]);
});

test('repeating an active add is a clean no-op: no row, counter, or marker changes', opts, async () => {
  const { spaceId, chatId } = await channel();
  await addToSpace(db, spaceId, bob, alice, ulid('msg'));
  const before = await db.selectFrom('memberships').selectAll()
    .where('scope_type', '=', 'space').where('scope_id', '=', spaceId)
    .where('actor_id', '=', bob).executeTakeFirstOrThrow();
  const chatBefore = await db.selectFrom('chats').select(['next_ord', 'next_rev'])
    .where('id', '=', chatId).executeTakeFirstOrThrow();

  const second = await addToSpace(db, spaceId, bob, alice, ulid('msg'));
  assert.equal(second.status, 'already_member');

  const after = await db.selectFrom('memberships').selectAll()
    .where('scope_type', '=', 'space').where('scope_id', '=', spaceId)
    .where('actor_id', '=', bob).executeTakeFirstOrThrow();
  assert.deepEqual(after, before, 'no role, joined_at, or left_at change');

  const chatAfter = await db.selectFrom('chats').select(['next_ord', 'next_rev'])
    .where('id', '=', chatId).executeTakeFirstOrThrow();
  assert.deepEqual(chatAfter, chatBefore, 'no ordinal or revision allocated — no second marker written');
});

test('re-adding a former member restores membership and writes one new marker', opts, async () => {
  const { spaceId } = await channel();
  await addToSpace(db, spaceId, bob, alice, ulid('msg'));
  await leaveSpace(db, spaceId, bob);
  assert.ok(!(await spaceMembers(db, spaceId)).includes(bob));

  const secondMessageId = ulid('msg');
  const result = await addToSpace(db, spaceId, bob, alice, secondMessageId);
  assert.equal(result.status, 'added');
  assert.ok((await spaceMembers(db, spaceId)).includes(bob));
  assert.ok(await messageRow(secondMessageId), 'a new marker for the new addition');
});

test('a sealed space refuses the add before anything is written', opts, async () => {
  const sealedId = ulid('spc');
  const chatId = ulid('cht');
  await db.insertInto('spaces').values({
    id: sealedId, org_id: org, workspace_id: workspaceId, kind: 'dm', name: null,
    slug: null, topic: null, visibility: null, membership_policy: 'sealed',
    created_by_actor_id: alice,
  }).execute();
  await db.insertInto('chats').values({
    id: chatId, workspace_id: workspaceId, space_id: sealedId, kind: 'sole',
    name: null, created_by_actor_id: alice,
  }).execute();
  await db.insertInto('memberships').values({
    scope_type: 'space', scope_id: sealedId, actor_id: alice, role: 'admin',
  }).execute();

  await assert.rejects(
    () => addToSpace(db, sealedId, bob, alice, ulid('msg')),
    (err: Error) => { assert.equal(err.name, 'SealedSpaceError'); return true; });
  assert.ok(!(await spaceMembers(db, sealedId)).includes(bob));
});
