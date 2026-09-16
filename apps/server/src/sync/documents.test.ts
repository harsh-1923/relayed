// Documents, and the summary a room is created with (docs/DOCUMENTS.md §4.1,
// §7.3) — against Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { createChannel, createRoom, addToSpace } from './spaces.ts';
import { spaceDocuments, ROOM_SUMMARY_TITLE } from './documents.ts';
import { welcome } from './feed.ts';
import type { SpaceMemberAdded } from './events.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const alice = ulid('act');
const bob = ulid('act');

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Docs' }).execute();
  await db.insertInto('workspaces').values({ id: wsp, org_id: org, name: 'Docs', slug: `d-${wsp.slice(-8).toLowerCase()}` }).execute();
  for (const id of [alice, bob]) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type: 'human', handle: `d-${id.slice(-8).toLowerCase()}`,
      display_name: 'Person', avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${id}`,
      owner_actor_id: null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member' }).execute();
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

test('a room is created with its summary and the panel it is read in; a channel is not', opts, async () => {
  const room = await createRoom(db, { workspaceId: wsp, name: `r-${ulid('x')}`, createdBy: alice });

  const document = await db.selectFrom('documents')
    .select(['kind', 'title', 'body', 'rev', 'format', 'updated_by_actor_id', 'covered_through', 'workspace_id'])
    .where('space_id', '=', room.spaceId).executeTakeFirstOrThrow();
  assert.deepEqual(document, {
    kind: 'room_summary', title: ROOM_SUMMARY_TITLE, body: '', rev: 0, format: 'markdown',
    updated_by_actor_id: null, covered_through: null, workspace_id: wsp,
  }, 'empty at rev 0 — a room nobody has said anything in, not a missing value');

  const panel = await db.selectFrom('panels').select(['type', 'title', 'payload', 'chat_id'])
    .where('space_id', '=', room.spaceId).executeTakeFirstOrThrow();
  assert.deepEqual(panel.type, 'doc');
  assert.equal(panel.chat_id, null);
  assert.equal(panel.title, ROOM_SUMMARY_TITLE);
  assert.deepEqual(panel.payload, { document_id: (await spaceDocuments(db, [room.spaceId]))[0]!.id });

  const channel = await createChannel(db, { workspaceId: wsp, name: `c-${ulid('x')}`, createdBy: alice });
  assert.deepEqual(await spaceDocuments(db, [channel.spaceId]), [], 'only a room keeps a summary');
});

test('a room has exactly one summary — the index says so, not the caller', opts, async () => {
  const room = await createRoom(db, { workspaceId: wsp, name: `r-${ulid('x')}`, createdBy: alice });
  await assert.rejects(() => db.insertInto('documents').values({
    id: ulid('doc'), workspace_id: wsp, space_id: room.spaceId, kind: 'room_summary', title: 'Second',
  }).execute(), /document_room_summary/);
});

test('the founding hydration carries the summary, so the creator has it at once', opts, async () => {
  const room = await createRoom(db, { workspaceId: wsp, name: `r-${ulid('x')}`, createdBy: alice });
  const founding = room.events.find(event => event.type === 'space.member_added');
  const hydration = (founding!.payload as SpaceMemberAdded).hydration;
  assert.equal(hydration.documents?.length, 1);
  assert.deepEqual([hydration.documents![0]!.kind, hydration.documents![0]!.rev], ['room_summary', 0]);
  assert.equal(hydration.panels?.length, 1, 'and the panel it is read in');
  assert.equal(hydration.panels![0]!.type, 'doc');
});

test('somebody added to a room is given the summary with it', opts, async () => {
  const room = await createRoom(db, { workspaceId: wsp, name: `r-${ulid('x')}`, createdBy: alice });
  await db.updateTable('documents').set({ body: '**Now.** Mid-migration.', rev: 3 })
    .where('space_id', '=', room.spaceId).execute();

  const added = await addToSpace(db, room.spaceId, bob, alice, ulid('msg'));
  assert.equal(added.status, 'added');
  if (added.status !== 'added') return;
  const hydration = (added.membershipEvent.payload as SpaceMemberAdded).hydration;
  assert.deepEqual(
    hydration.documents?.map(document => [document.body, document.rev]),
    [['**Now.** Mid-migration.', 3]],
    'the summary before they have read a single message');
});

test('welcome carries the documents of every space the actor has joined', opts, async () => {
  const room = await createRoom(db, { workspaceId: wsp, name: `r-${ulid('x')}`, createdBy: bob });
  await db.updateTable('documents')
    .set({ body: 'Rolling back first.', rev: 2, updated_by_actor_id: alice, covered_through: sql`${JSON.stringify({ cht_x: 41 })}::jsonb` })
    .where('space_id', '=', room.spaceId).execute();

  const payload = await welcome(db, wsp, bob);
  const mine = payload.documents.filter(document => document.space_id === room.spaceId);
  assert.equal(mine.length, 1);
  assert.deepEqual(
    { body: mine[0]!.body, rev: mine[0]!.rev, by: mine[0]!.updated_by_actor_id, covered: mine[0]!.covered_through },
    { body: 'Rolling back first.', rev: 2, by: alice, covered: { cht_x: 41 } });
  assert.ok(payload.panels.some(panel => panel.space_id === room.spaceId && panel.type === 'doc'),
    'and the panel, which rides with the other panels');

  const others = await welcome(db, wsp, alice);
  assert.equal(others.documents.some(document => document.space_id === room.spaceId), false,
    'a room this actor has not joined is not in their welcome');
});
