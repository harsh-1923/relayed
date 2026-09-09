// Every constraint in 005_sync.sql, one test each, against a real engine.
//
// A test PER constraint rather than a test that inserts a good row and calls it
// verified: the failure this guards is a CHECK that permits exactly the row it
// forbids, and that shape passes any test which only exercises the happy path
// (DESIGN.md §13.5).
//
// Postgres and SQLite agree on the dangerous part — a CHECK rejects a row only
// when it evaluates to FALSE, and `NULL IN (...)` is NULL, so a constraint over
// a nullable column PASSES on NULL unless it guards explicitly. The design
// records that trap against SQLite; these assert it holds here too, rather than
// assuming the two engines behave alike.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool } from './client.ts';
import { ulid } from './ulid.ts';

const reachable = await pool.query('SELECT 1').then(() => true).catch(() => false);
const opts = reachable ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const actor = ulid('act');

before(async () => {
  if (!reachable) return;
  await db.insertInto('organizations')
    .values({ id: org, workos_org_id: `test_${org}`, name: 'Schema test' }).execute();
  await db.insertInto('workspaces')
    .values({ id: wsp, org_id: org, name: 'Schema test', slug: `t-${wsp.slice(-6).toLowerCase()}` })
    .execute();
  await db.insertInto('actors').values({
    id: actor, org_id: org, workspace_id: wsp, type: 'human',
    handle: `t-${actor.slice(-6).toLowerCase()}`, display_name: 'Schema Test',
    avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${actor}`,
    owner_actor_id: null, provisioned_by: 'api', state: 'active',
  }).execute();
});

after(async () => {
  if (!reachable) return;
  // Spaces FIRST, which cascades to chats and messages. Only then the org.
  //
  // Not incidental tidiness — see the "tearing an organization down" test
  // below. `messages.author_id` is ON DELETE RESTRICT, so an org delete that
  // reaches `actors` while messages still exist fails, and Postgres does not
  // promise an order between two cascade paths from the same parent.
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

/** A valid channel, with one field overridden to whatever is under test. */
const channel = (over: Record<string, unknown> = {}) => ({
  id: ulid('spc'), org_id: org, workspace_id: wsp, kind: 'channel' as const,
  name: 'general', slug: null, topic: null, visibility: 'public' as const,
  membership_policy: 'open' as const, created_by_actor_id: actor, ...over,
});

const insertSpace = (over: Record<string, unknown> = {}) =>
  // eslint-disable-next-line
  db.insertInto('spaces').values(channel(over) as never).execute();

const rejects = async (fn: () => Promise<unknown>, constraint: string) => {
  await assert.rejects(fn, (err: Error) => {
    assert.match(err.message, new RegExp(constraint),
      `expected ${constraint} to reject this row; got: ${err.message}`);
    return true;
  });
};

// ── spaces: the policy matrix ───────────────────────────────────────────────

test('a valid channel inserts', opts, async () => {
  await insertSpace();
});

test('space_kind rejects an unknown kind', opts, async () => {
  await rejects(() => insertSpace({ kind: 'wormhole' }), 'space_kind');
});

test('space_policy rejects an unknown membership policy', opts, async () => {
  await rejects(() => insertSpace({ membership_policy: 'whoever' }), 'space_policy');
});

test('space_lifecycle rejects an unknown lifecycle', opts, async () => {
  await rejects(() => insertSpace({ lifecycle: 'mothballed' }), 'space_lifecycle');
});

test('THE NULL TRAP: space_visibility rejects a channel with NULL visibility', opts, async () => {
  // The whole reason these are tests rather than a careful read. Written the
  // natural way — `kind IN ('dm','group_dm') OR visibility IN (...)` — this row
  // PASSES, because FALSE OR NULL is NULL and a CHECK only rejects FALSE.
  await rejects(() => insertSpace({ visibility: null }), 'space_visibility');
});

test('space_visibility rejects an unknown visibility', opts, async () => {
  await rejects(() => insertSpace({ visibility: 'translucent' }), 'space_visibility');
});

test('space_visibility rejects a DM that HAS a visibility', opts, async () => {
  // The other side of the same constraint: a DM is neither public nor private,
  // and letting it carry one would put a meaningless value in every query that
  // reads visibility.
  await rejects(
    () => insertSpace({ kind: 'dm', name: null, visibility: 'public',
                        membership_policy: 'sealed' }),
    'space_visibility');
});

test('THE NULL TRAP AGAIN: space_named rejects a channel with no name', opts, async () => {
  await rejects(() => insertSpace({ name: null }), 'space_named');
});

test('space_named permits a DM with no name — it derives one from its members', opts, async () => {
  await insertSpace({ kind: 'dm', name: null, visibility: null, membership_policy: 'sealed' });
});

test('space_dm_sealed rejects a DM anyone may join', opts, async () => {
  await rejects(
    () => insertSpace({ kind: 'dm', name: null, visibility: null, membership_policy: 'open' }),
    'space_dm_sealed');
});

test('space_dm_lifecycle rejects an archived DM', opts, async () => {
  // Closing a DM is `dormant`, which the lifecycle already provides.
  await rejects(
    () => insertSpace({ kind: 'dm', name: null, visibility: null,
                        membership_policy: 'sealed', lifecycle: 'archived' }),
    'space_dm_lifecycle');
});

test('space_slug is unique per workspace, and only where a slug exists', opts, async () => {
  const slug = `dup-${ulid('s').slice(-8).toLowerCase()}`;
  await insertSpace({ slug });
  await rejects(() => insertSpace({ slug }), 'space_slug');
  // Two slugless spaces must not collide with each other — the index is partial
  // precisely so DMs, which have no slug, do not all conflict on NULL.
  await insertSpace({ slug: null });
  await insertSpace({ slug: null });
});

test('NEGATIVE CONTROL: the natural spelling really does permit what it forbids', opts, async () => {
  // Not a description of the trap — the trap, executed. A scratch table carries
  // the constraint written the obvious way, and accepts the exact row the real
  // one rejects. Without this, "we wrote it the careful way" is an assertion
  // about a diff nobody re-reads; with it, simplifying the constraint back to
  // the obvious form makes this test fail loudly.
  await pool.query(`
    CREATE TEMP TABLE null_trap (
      kind TEXT NOT NULL,
      visibility TEXT,
      CONSTRAINT natural_spelling
        CHECK (kind IN ('dm','group_dm') OR visibility IN ('public','private')))`);

  // FALSE OR NULL is NULL, and a CHECK only rejects FALSE — so this passes.
  await pool.query(`INSERT INTO null_trap VALUES ('channel', NULL)`);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM null_trap');
  assert.equal(rows[0].n, 1,
    'the natural spelling admitted the row — which is the whole point');

  // And the guarded spelling, the one 005_sync.sql uses, rejects it.
  await pool.query(`
    CREATE TEMP TABLE null_guarded (
      kind TEXT NOT NULL,
      visibility TEXT,
      CONSTRAINT guarded_spelling CHECK (
        CASE WHEN kind IN ('dm','group_dm')
             THEN visibility IS NULL
             ELSE visibility IS NOT NULL AND visibility IN ('public','private') END))`);
  await assert.rejects(
    () => pool.query(`INSERT INTO null_guarded VALUES ('channel', NULL)`),
    /guarded_spelling/);
});

// ── chats: the structural singleton ─────────────────────────────────────────

const insertChat = (over: Record<string, unknown> = {}) => {
  const values = { id: ulid('cht'), workspace_id: wsp, kind: 'sole' as const,
                   name: null, created_by_actor_id: actor, ...over };
  return db.insertInto('chats').values(values as never).execute();
};

test('chat_kind rejects an unknown kind', opts, async () => {
  const space = channel();
  await db.insertInto('spaces').values(space as never).execute();
  await rejects(() => insertChat({ space_id: space.id, kind: 'sidebar' }), 'chat_kind');
});

test('chat_singleton rejects a SECOND sole chat in one space', opts, async () => {
  // The index that makes "a channel has exactly one message list" unbreakable
  // by application code, and "a room's shared floor cannot be removed"
  // structural rather than remembered.
  const space = channel();
  await db.insertInto('spaces').values(space as never).execute();
  await insertChat({ space_id: space.id, kind: 'sole' });
  await rejects(() => insertChat({ space_id: space.id, kind: 'sole' }), 'chat_singleton');
});

test('chat_singleton counts sole and default TOGETHER, not separately', opts, async () => {
  // Both are "the space's structural chat". An index per kind would let a space
  // hold one of each, which is meaningless.
  const space = channel({ kind: 'room', membership_policy: 'invite' });
  await db.insertInto('spaces').values(space as never).execute();
  await insertChat({ space_id: space.id, kind: 'default' });
  await rejects(() => insertChat({ space_id: space.id, kind: 'sole' }), 'chat_singleton');
});

test('a room may hold many public and private chats', opts, async () => {
  // The partial index must NOT constrain these, or rooms cannot exist.
  const space = channel({ kind: 'room', membership_policy: 'invite' });
  await db.insertInto('spaces').values(space as never).execute();
  await insertChat({ space_id: space.id, kind: 'default' });
  await insertChat({ space_id: space.id, kind: 'public', name: 'design' });
  await insertChat({ space_id: space.id, kind: 'public', name: 'triage' });
  await insertChat({ space_id: space.id, kind: 'private', name: 'leads' });
});

test('allocation counters start at zero and are not nullable', opts, async () => {
  const space = channel();
  await db.insertInto('spaces').values(space as never).execute();
  const id = ulid('cht');
  await insertChat({ id, space_id: space.id });
  const row = await db.selectFrom('chats').select(['next_ord', 'next_rev'])
    .where('id', '=', id).executeTakeFirstOrThrow();
  assert.equal(Number(row.next_ord), 0);
  assert.equal(Number(row.next_rev), 0);
});

// ── messages: ord is never reused, and a delete keeps its row ───────────────

/** A space with its sole chat, ready to hold messages. */
async function chatFixture() {
  const space = channel();
  await db.insertInto('spaces').values(space as never).execute();
  const chat = ulid('cht');
  await db.insertInto('chats').values({
    id: chat, workspace_id: wsp, space_id: space.id, kind: 'sole',
    name: null, created_by_actor_id: actor } as never).execute();
  return chat;
}

const insertMessage = (chat: string, over: Record<string, unknown> = {}) =>
  db.insertInto('messages').values({
    id: ulid('msg'), chat_id: chat, parent_id: null, ord: 1, rev: 1,
    author_id: actor, body: 'hello', ...over } as never).execute();

test('msg_ord rejects a SECOND message at the same ordinal', opts, async () => {
  // What makes "ord is never renumbered or reused" enforced rather than
  // conventional. Reusing one corrupts read cursors and scroll positions across
  // every client that already saw the first.
  const chat = await chatFixture();
  await insertMessage(chat, { ord: 1 });
  await rejects(() => insertMessage(chat, { ord: 1 }), 'msg_ord');
});

test('the same ordinal in a DIFFERENT chat is fine — ord is per chat', opts, async () => {
  const first = await chatFixture();
  const second = await chatFixture();
  await insertMessage(first, { ord: 1 });
  await insertMessage(second, { ord: 1 });
});

test('a delete keeps the row and its ordinal, leaving a gap', opts, async () => {
  // The behaviour `delete` was pulled into this phase to exercise
  // (PHASE-2-SYNC.md §1): a tombstone, not a removal. The gap in the sequence
  // is normal, and anything that tries to close it is a bug.
  const chat = await chatFixture();
  const doomed = ulid('msg');
  await insertMessage(chat, { id: doomed, ord: 1, rev: 1 });
  await insertMessage(chat, { ord: 2, rev: 2 });
  await insertMessage(chat, { ord: 3, rev: 3 });

  // What step C's `delete` will do: rev advances, ord does not, body is cleared.
  await db.updateTable('messages').set({ deleted: true, body: '', rev: 4 })
    .where('id', '=', doomed).execute();

  const rows = await db.selectFrom('messages').select(['ord', 'deleted', 'rev'])
    .where('chat_id', '=', chat).orderBy('ord').execute();
  assert.deepEqual(rows.map(r => Number(r.ord)), [1, 2, 3], 'the ordinal survives');
  assert.equal(rows[0]?.deleted, true);
  assert.equal(Number(rows[0]?.rev), 4, 'rev advanced past every live message');

  // And the ordinal stays taken: nothing may be inserted into the gap.
  await rejects(() => insertMessage(chat, { ord: 1 }), 'msg_ord');
});

test('an author cannot be deleted out from under their messages', opts, async () => {
  // ON DELETE RESTRICT, deliberately. Deactivation tombstones an actor and
  // never removes the row (DESIGN.md §6.3) — a deactivated author still has to
  // render on the messages they wrote, offline included.
  const chat = await chatFixture();
  await insertMessage(chat);
  await rejects(() => db.deleteFrom('actors').where('id', '=', actor).execute(),
                'messages_author_id_fkey');
});

// ── the idempotency ledger ─────────────────────────────────────────────────

test('ops rejects a replayed op_id', opts, async () => {
  // The row that stops a lost ack from producing a duplicate message.
  const chat = await chatFixture();
  const op = ulid('op');
  const values = { op_id: op, actor_id: actor, chat_id: chat, kind: 'send' as const,
                   result: JSON.stringify({ ord: 1, rev: 1 }) };
  await db.insertInto('ops').values(values as never).execute();
  await rejects(() => db.insertInto('ops').values(values as never).execute(), 'ops_pkey');
});

test('op_kind admits send and delete, and nothing else this phase', opts, async () => {
  const chat = await chatFixture();
  const base = { actor_id: actor, chat_id: chat, result: JSON.stringify({}) };
  await db.insertInto('ops')
    .values({ ...base, op_id: ulid('op'), kind: 'send' } as never).execute();
  await db.insertInto('ops')
    .values({ ...base, op_id: ulid('op'), kind: 'delete' } as never).execute();
  // `edit` and `react` arrive in Phase 4 and must widen this deliberately.
  await rejects(
    () => db.insertInto('ops')
      .values({ ...base, op_id: ulid('op'), kind: 'edit' } as never).execute(),
    'op_kind');
});

test('the ledger stores the ack verbatim, so a replay cannot recompute it', opts, async () => {
  const chat = await chatFixture();
  const op = ulid('op');
  const ack = { t: 'ack', op_id: op, ord: 7, rev: 9 };
  await db.insertInto('ops').values({
    op_id: op, actor_id: actor, chat_id: chat, kind: 'send',
    result: JSON.stringify(ack) } as never).execute();
  const row = await db.selectFrom('ops').select('result')
    .where('op_id', '=', op).executeTakeFirstOrThrow();
  assert.deepEqual(row.result, ack);
});

// ── per-actor read state ───────────────────────────────────────────────────

test('read state is one row per (actor, chat)', opts, async () => {
  const chat = await chatFixture();
  const values = { chat_id: chat, actor_id: actor };
  await db.insertInto('chat_read_state').values(values as never).execute();
  await rejects(() => db.insertInto('chat_read_state').values(values as never).execute(),
                'chat_read_state_pkey');
});

test('read state defaults to zero, so an unopened chat is fully unread', opts, async () => {
  const chat = await chatFixture();
  await db.insertInto('chat_read_state').values({ chat_id: chat, actor_id: actor } as never)
    .execute();
  const row = await db.selectFrom('chat_read_state')
    .select(['last_read_ord', 'chat_unread', 'thread_unread', 'mention_count'])
    .where('chat_id', '=', chat).executeTakeFirstOrThrow();
  assert.deepEqual(
    [row.last_read_ord, row.chat_unread, row.thread_unread, row.mention_count].map(Number),
    [0, 0, 0, 0]);
});

test('tearing an organization down needs its messages removed first', opts, async () => {
  // Found by a failing teardown, kept as a test because it is a real property
  // of the schema rather than a quirk of this file.
  //
  // `messages.author_id` is ON DELETE RESTRICT so that no actor can be removed
  // out from under the history they wrote. Deactivation tombstones rather than
  // deletes (DESIGN.md §6.3), so nothing in normal operation trips it. A full
  // tenant teardown does: `organizations` cascades to `actors` down one path
  // and to `messages` down another, and Postgres promises no order between
  // them — so the delete must be staged rather than issued as one statement.
  const tenantOrg = ulid('org');
  const tenantWsp = ulid('wsp');
  const tenantActor = ulid('act');
  await db.insertInto('organizations')
    .values({ id: tenantOrg, workos_org_id: `test_${tenantOrg}`, name: 'Doomed' }).execute();
  await db.insertInto('workspaces').values({
    id: tenantWsp, org_id: tenantOrg, name: 'Doomed',
    slug: `t-${tenantWsp.slice(-6).toLowerCase()}` }).execute();
  await db.insertInto('actors').values({
    id: tenantActor, org_id: tenantOrg, workspace_id: tenantWsp, type: 'human',
    handle: `t-${tenantActor.slice(-6).toLowerCase()}`, display_name: 'Doomed',
    avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${tenantActor}`,
    owner_actor_id: null, provisioned_by: 'api', state: 'active' }).execute();

  const space = ulid('spc');
  const chat = ulid('cht');
  await db.insertInto('spaces').values({
    id: space, org_id: tenantOrg, workspace_id: tenantWsp, kind: 'channel',
    name: 'general', slug: null, topic: null, visibility: 'public',
    membership_policy: 'open', created_by_actor_id: tenantActor } as never).execute();
  await db.insertInto('chats').values({
    id: chat, workspace_id: tenantWsp, space_id: space, kind: 'sole',
    name: null, created_by_actor_id: tenantActor } as never).execute();
  await db.insertInto('messages').values({
    id: ulid('msg'), chat_id: chat, parent_id: null, ord: 1, rev: 1,
    author_id: tenantActor, body: 'hello' } as never).execute();

  // One statement is not enough, and fails loudly rather than half-deleting.
  await rejects(() => db.deleteFrom('organizations').where('id', '=', tenantOrg).execute(),
                'messages_author_id_fkey');

  // Staged, it succeeds: spaces cascade to chats and messages, then the rest.
  await db.deleteFrom('spaces').where('workspace_id', '=', tenantWsp).execute();
  await db.deleteFrom('organizations').where('id', '=', tenantOrg).execute();
  const left = await db.selectFrom('actors').select('id')
    .where('org_id', '=', tenantOrg).execute();
  assert.deepEqual(left, [], 'the tenant is gone once its messages are');
});
