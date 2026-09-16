// Picking rooms to summarise, and writing the revision (docs/DOCUMENTS.md §4).
//
// The runtime call itself is not exercised here — it needs `apps/agent` — so
// what is tested is everything either side of it: which rooms are due, what the
// agent may count towards that, and the write path both writers share.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { createRoom } from '../sync/spaces.ts';
import { writeDocumentRevision, REVISION_RETENTION, BODY_LIMIT_BYTES } from '../sync/documents.ts';
import { provisionSystemAgents, systemAgentId, ROOMKEEPER_HANDLE } from '../provisioning/system-agents.ts';
import { dueSummaries } from './summariser.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const alice = ulid('act');
let roomkeeper = '';

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Summaries' }).execute();
  await db.insertInto('workspaces').values({ id: wsp, org_id: org, name: 'Summaries', slug: `m-${wsp.slice(-8).toLowerCase()}` }).execute();
  await db.insertInto('actors').values({
    id: alice, org_id: org, workspace_id: wsp, type: 'human', handle: `p-${alice.slice(-8).toLowerCase()}`,
    display_name: 'Alice', avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${alice}`,
    owner_actor_id: null, provisioned_by: 'api', state: 'active',
  }).execute();
  await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: alice, role: 'admin' }).execute();
  await provisionSystemAgents(db, wsp);
  roomkeeper = (await systemAgentId(db, wsp, ROOMKEEPER_HANDLE)) ?? '';
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

/** A room with its summary, its Roomkeeping membership and `n` messages in its default chat. */
async function roomWith(n: number, options: { visibleTo?: string[] } = {}) {
  const room = await createRoom(db, { workspaceId: wsp, name: `Room ${ulid('r').slice(-6)}`, createdBy: alice });
  await say(room.chatId, n, options);
  // The floor is 60s since the last write, and a room created this millisecond
  // has not passed it. Backdating is what lets the rule be tested without
  // sleeping through it.
  await db.updateTable('documents').set({ updated_at: sql`now() - interval '10 minutes'` })
    .where('space_id', '=', room.spaceId).execute();
  return room;
}

async function say(chatId: string, n: number, options: { visibleTo?: string[] } = {}): Promise<void> {
  const head = await db.selectFrom('chats').select('next_ord').where('id', '=', chatId).executeTakeFirstOrThrow();
  // The first message in a chat is ord 1: `allocateChat` returns `next_ord + 1`.
  // Numbering from 0 here would invent a message no real chat has, and the
  // watermark's `ord > 0` would then look like an off-by-one.
  const first = Number(head.next_ord) + 1;
  for (let i = 0; i < n; i++) {
    await db.insertInto('messages').values({
      id: ulid('msg'), chat_id: chatId, parent_id: null, author_id: alice,
      body: `message ${i}`, ord: first + i, rev: first + i,
      edited_at: null, on_behalf_of_actor_id: null, delegation_id: null,
      visible_to: options.visibleTo ?? null, parts: null, system_kind: null, subject_actor_id: null,
    }).execute();
  }
  await db.updateTable('chats').set({ next_ord: first + n - 1, next_rev: first + n - 1 })
    .where('id', '=', chatId).execute();
}

const dueIds = async (threshold = 15): Promise<string[]> =>
  (await dueSummaries(db, threshold, 50)).map(row => row.spaceId);

test('a room is due once it is the threshold behind, and not before', opts, async () => {
  const quiet = await roomWith(14);
  const busy = await roomWith(15);

  const due = await dueIds();
  assert.ok(due.includes(busy.spaceId), 'fifteen new messages is due');
  assert.ok(!due.includes(quiet.spaceId), 'fourteen is not');

  const found = (await dueSummaries(db, 15, 50)).find(row => row.spaceId === busy.spaceId);
  assert.equal(found?.newMessages, 15);
  assert.equal(found?.roomkeeperId, roomkeeper);
});

test('a private chat in the room is never counted', opts, async () => {
  const room = await roomWith(2);
  const privateChat = ulid('cht');
  await db.insertInto('chats').values({
    id: privateChat, workspace_id: wsp, space_id: room.spaceId, kind: 'private',
    name: 'just us', created_by_actor_id: alice,
  }).execute();
  await say(privateChat, 40);

  // Forty messages the agent has no chat-scoped membership for. If they counted,
  // this room would be due — and the summary would then be built from them.
  assert.ok(!(await dueIds()).includes(room.spaceId));
});

test('a restricted message the agent is not listed on is never counted', opts, async () => {
  const room = await roomWith(0);
  await say(room.chatId, 20, { visibleTo: [alice] });
  assert.ok(!(await dueIds()).includes(room.spaceId));

  // The same room, with messages nobody restricted, is due.
  await say(room.chatId, 20);
  assert.ok((await dueIds()).includes(room.spaceId));
});

test('a dormant room keeps its summary and is skipped', opts, async () => {
  const room = await roomWith(30);
  assert.ok((await dueIds()).includes(room.spaceId));

  await db.updateTable('spaces').set({ lifecycle: 'dormant' }).where('id', '=', room.spaceId).execute();
  assert.ok(!(await dueIds()).includes(room.spaceId));

  const document = await db.selectFrom('documents').select(['rev', 'body'])
    .where('space_id', '=', room.spaceId).executeTakeFirstOrThrow();
  assert.equal(document.rev, 0);
});

test('a leased room is not offered again until the lease expires', opts, async () => {
  const room = await roomWith(20);
  await db.updateTable('documents').set({ refresh_lease_until: sql`now() + interval '2 minutes'` })
    .where('space_id', '=', room.spaceId).execute();
  assert.ok(!(await dueIds()).includes(room.spaceId));

  await db.updateTable('documents').set({ refresh_lease_until: sql`now() - interval '1 second'` })
    .where('space_id', '=', room.spaceId).execute();
  assert.ok((await dueIds()).includes(room.spaceId), 'a lease in the past means the server that held it is gone');
});

test('a revision bumps rev, records itself, and says so on the space stream', opts, async () => {
  const room = await roomWith(0);
  const document = await db.selectFrom('documents').select('id').where('space_id', '=', room.spaceId).executeTakeFirstOrThrow();

  const first = await writeDocumentRevision(db, {
    documentId: document.id, body: '**Now.** Something is happening.',
    authorActorId: roomkeeper, coveredThrough: { [room.chatId]: 4 },
  });
  assert.equal(first.rev, 1);
  assert.equal(first.event.type, 'document.updated');

  // A second writer — somebody asking Roomkeeping to fix it — does NOT move the
  // watermark: a request is not a pass over the messages (§4.8).
  const second = await writeDocumentRevision(db, {
    documentId: document.id, body: 'Corrected.', authorActorId: roomkeeper,
  });
  assert.equal(second.rev, 2);

  const row = await db.selectFrom('documents').select(['body', 'rev', 'covered_through', 'updated_by_actor_id'])
    .where('id', '=', document.id).executeTakeFirstOrThrow();
  assert.equal(row.body, 'Corrected.');
  assert.equal(row.rev, 2);
  assert.deepEqual(row.covered_through, { [room.chatId]: 4 });
  assert.equal(row.updated_by_actor_id, roomkeeper);

  const revisions = await db.selectFrom('document_revisions').select(['rev', 'body'])
    .where('document_id', '=', document.id).orderBy('rev').execute();
  assert.deepEqual(revisions.map(r => r.rev), [1, 2]);
});

test('a body over the cap is trimmed, and the history keeps the last fifty', opts, async () => {
  const room = await roomWith(0);
  const document = await db.selectFrom('documents').select('id').where('space_id', '=', room.spaceId).executeTakeFirstOrThrow();

  await writeDocumentRevision(db, {
    documentId: document.id, body: 'x'.repeat(BODY_LIMIT_BYTES + 500), authorActorId: roomkeeper,
  });
  const capped = await db.selectFrom('documents').select('body').where('id', '=', document.id).executeTakeFirstOrThrow();
  assert.equal(Buffer.byteLength(capped.body, 'utf8'), BODY_LIMIT_BYTES);

  for (let i = 0; i < REVISION_RETENTION + 3; i++) {
    await writeDocumentRevision(db, { documentId: document.id, body: `rev ${i}`, authorActorId: roomkeeper });
  }
  const revisions = await db.selectFrom('document_revisions').select('rev')
    .where('document_id', '=', document.id).orderBy('rev').execute();
  assert.equal(revisions.length, REVISION_RETENTION);
  // Pruned from the OLD end: the newest fifty are what a reader would ever want.
  assert.equal(revisions.at(-1)?.rev, REVISION_RETENTION + 4);
});

