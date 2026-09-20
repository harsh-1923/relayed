// The index into what memory holds, against Postgres (docs/MEMORY.md §8.3).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import {
  documentIdFor, recordDocument, documentsCovering, documentsForSpace, type MemoryDocument,
} from './documents.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const workspace = ulid('wsp');
const space = ulid('spc');
const chat = ulid('cht');
const bank = `mem_s_${space}`;

const episode = (ordStart: number, ordEnd: number): MemoryDocument => ({
  bankId: bank, documentId: documentIdFor(chat, ordStart, ordEnd),
  workspaceId: workspace, spaceId: space, chatId: chat, ordStart, ordEnd,
  sourceRevMax: ordEnd,
});

before(async () => {
  if (!up) return;
  await db.insertInto('organizations')
    .values({ id: org, workos_org_id: `test_${org}`, name: 'Memory' }).execute();
  await db.insertInto('workspaces')
    .values({ id: workspace, org_id: org, name: 'Memory', slug: `m-${workspace.slice(-8).toLowerCase()}` })
    .execute();
  await db.insertInto('spaces').values({
    id: space, org_id: org, workspace_id: workspace, kind: 'room', name: 'cutover',
    slug: null, topic: null, visibility: 'private', membership_policy: 'invite',
    created_by_actor_id: null,
  }).execute();
  await db.insertInto('chats')
    .values({ id: chat, workspace_id: workspace, space_id: space, kind: 'default', name: null })
    .execute();
});

after(async () => {
  if (up) await sql`DELETE FROM organizations WHERE id = ${org}`.execute(db);
  await pool.end();
});

test('a document id is derived from the episode, so a retry recomputes the same one', opts, () => {
  // Not a fresh ULID: a retry that recomputes the same episode must REPLACE its
  // document rather than duplicate it, the same reasoning as client-generated
  // message ids (DESIGN.md §10.1).
  assert.equal(documentIdFor(chat, 412, 431), documentIdFor(chat, 412, 431));
  assert.notEqual(documentIdFor(chat, 412, 431), documentIdFor(chat, 412, 432));
});

test('recording is idempotent — a retry leaves one row, not two', opts, async () => {
  await recordDocument(db, episode(1, 20));
  await recordDocument(db, episode(1, 20));
  const rows = await documentsForSpace(db, space);
  assert.equal(rows.filter((row) => row.documentId === documentIdFor(chat, 1, 20)).length, 1);
});

test('a deleted message finds the document its episode covers, and no neighbour', opts, async () => {
  await recordDocument(db, episode(21, 40));
  await recordDocument(db, episode(41, 60));

  const covering = await documentsCovering(db, chat, 45);
  assert.deepEqual(covering.map((row) => row.documentId), [documentIdFor(chat, 41, 60)]);

  assert.equal((await documentsCovering(db, chat, 40))[0]?.documentId, documentIdFor(chat, 21, 40));
  assert.equal((await documentsCovering(db, chat, 61)).length, 0);
});

test('two documents covering one ordinal are BOTH returned', opts, async () => {
  // A re-ingest that widened an episode can leave two spanning the same message.
  // Forgetting only the first would leave the fact recallable from the second,
  // which is why this returns a list rather than the first row it finds.
  await recordDocument(db, episode(100, 120));
  await recordDocument(db, episode(110, 130));
  const covering = await documentsCovering(db, chat, 115);
  assert.equal(covering.length, 2);
});

test('a chat in another space is never returned', opts, async () => {
  const elsewhere = ulid('cht');
  await db.insertInto('chats')
    .values({ id: elsewhere, workspace_id: workspace, space_id: space, kind: 'public', name: 'side' })
    .execute();
  await recordDocument(db, { ...episode(1, 20), chatId: elsewhere,
                             documentId: documentIdFor(elsewhere, 1, 20) });
  const covering = await documentsCovering(db, chat, 10);
  assert.ok(covering.every((row) => row.chatId === chat));
});

test('deleting the space cascades the index away with it', opts, async () => {
  const doomed = ulid('spc');
  const doomedChat = ulid('cht');
  await db.insertInto('spaces').values({
    id: doomed, org_id: org, workspace_id: workspace, kind: 'channel', name: 'doomed',
    slug: `d-${doomed.slice(-8).toLowerCase()}`, topic: null, visibility: 'private',
    membership_policy: 'invite', created_by_actor_id: null,
  }).execute();
  await db.insertInto('chats')
    .values({ id: doomedChat, workspace_id: workspace, space_id: doomed, kind: 'sole', name: null })
    .execute();
  await recordDocument(db, { bankId: `mem_s_${doomed}`, documentId: documentIdFor(doomedChat, 1, 5),
                             workspaceId: workspace, spaceId: doomed, chatId: doomedChat,
                             ordStart: 1, ordEnd: 5, sourceRevMax: 5 });
  assert.equal((await documentsForSpace(db, doomed)).length, 1);

  await sql`DELETE FROM spaces WHERE id = ${doomed}`.execute(db);
  assert.equal((await documentsForSpace(db, doomed)).length, 0);
});
