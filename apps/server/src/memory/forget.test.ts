// Knowing a conversation changed under us (docs/MEMORY.md §8.1).
//
// `staleDocuments` is tested against Postgres; `rebuild` needs a real bank and
// is exercised by hand (`scripts/memory-forget.ts`). The interesting half is
// here anyway: whether the sweep CONVERGES, or rebuilds the same document for
// ever because a tombstone never stops looking like a deletion.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { ROOMKEEPER_HANDLE } from '../provisioning/system-agents.ts';
import { recordDocument } from './documents.ts';
import { staleDocuments } from './forget.ts';
import { revMax, type EpisodeMessage } from './episode.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const workspace = ulid('wsp');
const keeper = ulid('act');
const alice = ulid('act');
const space = ulid('spc');
const chat = ulid('cht');
const bank = `mem_s_${space}`;
const documentId = `${chat}:1-4`;

/** Five messages, ords 1..5, revs 1..5. The document covers 1..4. */
before(async () => {
  if (!up) return;
  await db.insertInto('organizations')
    .values({ id: org, workos_org_id: `test_${org}`, name: 'Forget' }).execute();
  await db.insertInto('workspaces')
    .values({ id: workspace, org_id: org, name: 'Forget', slug: `f-${workspace.slice(-8).toLowerCase()}` })
    .execute();
  for (const [id, handle, type, system] of [
    [keeper, ROOMKEEPER_HANDLE, 'agent', true], [alice, `a-${alice.slice(-6).toLowerCase()}`, 'human', false],
  ] as const) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: workspace, type, handle, display_name: handle,
      avatar_url: null, identity_kind: system ? 'system' : 'workos_user',
      identity_id: system ? null : `wu_${id}`, owner_actor_id: null,
      provisioned_by: system ? 'system' : 'api', state: 'active',
    }).execute();
  }
  await db.insertInto('spaces').values({
    id: space, org_id: org, workspace_id: workspace, kind: 'room', name: 'forgetting',
    slug: null, topic: null, visibility: 'private', membership_policy: 'invite',
    created_by_actor_id: alice,
  }).execute();
  await db.insertInto('chats')
    .values({ id: chat, workspace_id: workspace, space_id: space, kind: 'default', name: null })
    .execute();
  for (let n = 1; n <= 5; n++) {
    await db.insertInto('messages').values({
      id: ulid('msg'), chat_id: chat, parent_id: null, ord: n, rev: n,
      author_id: alice, body: `message number ${n}`, visible_to: null, deleted: false,
      on_behalf_of_actor_id: null, delegation_id: null,
    }).execute();
  }
  await recordDocument(db, {
    bankId: bank, documentId, workspaceId: workspace, spaceId: space, chatId: chat,
    ordStart: 1, ordEnd: 4, sourceRevMax: 4,
  });
});

after(async () => {
  if (up) {
    await sql`DELETE FROM messages WHERE chat_id = ${chat}`.execute(db);
    await sql`DELETE FROM organizations WHERE id = ${org}`.execute(db);
  }
  await pool.end();
});

const stale = async () => (await staleDocuments(db)).filter((row) => row.documentId === documentId);

test('the mark is the highest revision in the episode', () => {
  const message = (ord: number, rev: number): EpisodeMessage => ({
    id: ulid('msg'), ord, rev, body: 'x', createdAt: new Date(),
    authorId: alice, authorDisplayName: 'A', authorHandle: 'a', authorType: 'human',
  });
  assert.equal(revMax([message(1, 3), message(2, 9), message(3, 5)]), 9);
  assert.equal(revMax([]), 0);
});

test('an untouched document is not stale', opts, async () => {
  assert.equal((await stale()).length, 0);
});

test('deleting a covered message makes it stale', opts, async () => {
  // A delete clears the body and raises the revision (`ops.ts`, `events.ts`).
  await sql`UPDATE messages SET deleted = true, body = '', rev = 11
             WHERE chat_id = ${chat} AND ord = 2`.execute(db);
  const found = await stale();
  assert.equal(found.length, 1);
  assert.equal(found[0]!.currentRevMax, 11);
});

test('rebuilding to the current mark makes it stop being stale — the sweep converges', opts, async () => {
  // THE TEST THIS FILE EXISTS FOR. `deleted` is a tombstone: the row stays and
  // keeps its ordinal for ever, so a sweep keyed on the flag would rebuild this
  // document on every tick until the end of time. Keyed on the revision, one
  // rebuild is enough.
  await recordDocument(db, {
    bankId: bank, documentId, workspaceId: workspace, spaceId: space, chatId: chat,
    ordStart: 1, ordEnd: 4, sourceRevMax: 11,
  });
  assert.equal((await stale()).length, 0, 'the tombstone is still there and must no longer matter');
});

test('editing a covered message makes it stale, which a deleted-flag check never would', opts, async () => {
  await sql`UPDATE messages SET body = 'edited', rev = 12
             WHERE chat_id = ${chat} AND ord = 3`.execute(db);
  const found = await stale();
  assert.equal(found.length, 1);
  assert.equal(found[0]!.currentRevMax, 12);
});

test('a change outside the document’s range leaves it alone', opts, async () => {
  await recordDocument(db, {
    bankId: bank, documentId, workspaceId: workspace, spaceId: space, chatId: chat,
    ordStart: 1, ordEnd: 4, sourceRevMax: 12,
  });
  // Ordinal 5 is outside 1..4.
  await sql`UPDATE messages SET deleted = true, body = '', rev = 20
             WHERE chat_id = ${chat} AND ord = 5`.execute(db);
  assert.equal((await stale()).length, 0);
});

test('a stale document carries the writer, so a rebuild reads as the writer', opts, async () => {
  // A message restricted away from Roomkeeping must not reappear just because
  // this is a rebuild rather than an ingest.
  await sql`UPDATE messages SET rev = 21 WHERE chat_id = ${chat} AND ord = 1`.execute(db);
  const found = await stale();
  assert.equal(found[0]?.writerActorId, keeper);
  assert.equal(found[0]?.spaceName, 'forgetting');
});
