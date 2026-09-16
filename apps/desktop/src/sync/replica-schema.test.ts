// The replica's Phase 2 schema, executed (PHASE-2-SYNC.md §3 step A).
//
// Same discipline as the server half: a test per constraint, run against a real
// engine, each asserted against an expected outcome. The failure being guarded
// is a CHECK that permits exactly the row it forbids, and that shape passes any
// test which only exercises the happy path (DESIGN.md §13.5).
//
// This file also asserts the two things that differ between the replica and the
// server, because "the client mirrors the server" is the kind of sentence that
// stays true in a document while drifting in code: an ordinal may be NULL here
// while a message is pending, and a message may name an author who has not
// replicated yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.ts';
import { migrate } from './migrate.ts';
import { workspaceMigrations } from './migrations/workspace.ts';

/** A migrated replica in a throwaway directory. */
function replica(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'relayed-replica-'));
  const db = openDatabase(join(dir, 'relayed.db'));
  migrate(db, workspaceMigrations);
  return db;
}

const rejects = (fn: () => unknown, why: RegExp) => assert.throws(fn, why);

const space = (over: Record<string, unknown> = {}) => ({
  id: 'spc_1', workspace_id: 'wsp_1', kind: 'channel', name: 'general',
  slug: null, topic: null, visibility: 'public', membership_policy: 'open',
  created_by_actor_id: 'act_1', created_at: 1, updated_at: 1, ...over,
});

function insertSpace(db: DatabaseSync, over: Record<string, unknown> = {}) {
  const row = space(over);
  db.prepare(`INSERT INTO spaces
    (id, workspace_id, kind, name, slug, topic, visibility, membership_policy,
     created_by_actor_id, created_at, updated_at${'lifecycle' in over ? ', lifecycle' : ''})
    VALUES (?,?,?,?,?,?,?,?,?,?,?${'lifecycle' in over ? ',?' : ''})`).run(
    row.id as string, row.workspace_id as string, row.kind as string,
    row.name as string | null, row.slug as string | null, row.topic as string | null,
    row.visibility as string | null, row.membership_policy as string,
    row.created_by_actor_id as string, row.created_at as number, row.updated_at as number,
    ...('lifecycle' in over ? [over['lifecycle'] as string] : []));
}

// ── the migration itself ────────────────────────────────────────────────────

test('every migration applies, and auto_vacuum SURVIVES them all', () => {
  // Invariant 11, re-asserted after the migration rather than only at open.
  // The pragma is silently ignored if anything materialises the header first,
  // and the symptom — a replica that grows for ever because eviction can never
  // return pages — appears months later on somebody else's disk.
  const db = replica();
  const row = db.prepare('SELECT * FROM pragma_auto_vacuum()').get() as Record<string, number>;
  assert.equal(Object.values(row)[0], 2);
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
  // Read off the list rather than hard-coded, so adding a migration does not
  // fail a test about auto_vacuum for a reason unrelated to auto_vacuum.
  assert.equal(version.user_version, workspaceMigrations.at(-1)!.version);
});

test('every sync table and the local composer draft table exist', () => {
  const db = replica();
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as
    { name: string }[]).map(r => r.name);
  for (const table of ['meta', 'actors', 'spaces', 'chats', 'memberships',
                       'messages', 'chat_state', 'stream_state', 'staged_events',
                       'outbox', 'drafts']) {
    assert.ok(names.includes(table), `missing ${table}`);
  }
  // Named rather than merely absent: each belongs to the phase that writes it,
  // and a table with no writer has constraints nothing has ever exercised.
  for (const later of ['reactions', 'messages_fts', 'blobs']) {
    assert.ok(!names.includes(later), `${later} arrived early`);
  }
});

test('an EXISTING version 1 replica upgrades all the way, keeping its rows', () => {
  // The case that actually happens in the field: reinstalling replaces the app
  // and leaves userData intact, so new code always meets an old database.
  const dir = mkdtempSync(join(tmpdir(), 'relayed-upgrade-'));
  const file = join(dir, 'relayed.db');
  const first = openDatabase(file);
  migrate(first, workspaceMigrations.filter(m => m.version === 1));
  first.prepare(`INSERT INTO actors
    (id, workspace_id, type, handle, display_name, avatar_url, avatar_blob,
     owner_actor_id, state, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('act_1', 'wsp_1', 'human', 'harsh', 'Harsh', null, null, null, 'active', 1);
  first.close();

  const second = openDatabase(file);
  const result = migrate(second, workspaceMigrations);
  assert.deepEqual(result,
    { from: 1, to: 20,
      applied: ['2:sync', '3:frontier', '4:trace', '5:stall', '6:workspace-membership', '7:drafts', '8:drafts-repair', '9:gap-repair', '10:restricted-messages', '11:agent-summaries', '12:message-parts', '13:space-membership-markers', '14:connections', '15:room_panels', '16:space_attribution', '17:dm_members', '18:documents', '19:system_agents', '20:space_rosters'] });
  // Spread: node:sqlite returns null-prototype rows, and assert/strict compares
  // prototypes as well as contents.
  const kept = (second.prepare('SELECT handle FROM actors').all() as { handle: string }[])
    .map(row => ({ ...row }));
  assert.deepEqual(kept, [{ handle: 'harsh' }], 'the upgrade preserved what was there');
  rmSync(dir, { recursive: true, force: true });
});

// ── actors ─────────────────────────────────────────────────────────────────

test('an agent with NO owner is stored, not refused', () => {
  // THE HOT LOOP (DOCUMENTS.md §9.1). Version 1 required an owner for every
  // agent, so `actor.created` for Relay — which has none — threw inside
  // `applyCatchup`, the workspace cursor never advanced, and the client asked
  // for the same range thousands of times a second. The replica holds what the
  // server sends; the server's own CHECK decides what may be sent.
  const db = replica();
  db.prepare(`INSERT INTO actors
    (id, workspace_id, type, handle, display_name, avatar_url, avatar_blob,
     owner_actor_id, state, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('act_relay', 'wsp_1', 'agent', 'relay', 'Relay', null, null, null, 'active', 1);
  const row = db.prepare('SELECT handle, owner_actor_id FROM actors').get() as
    { handle: string; owner_actor_id: string | null };
  assert.equal(row.handle, 'relay');
  assert.equal(row.owner_actor_id, null);
});

test('type and state stay closed sets — those this build renders by name', () => {
  const db = replica();
  const insert = (over: { type?: string; state?: string }) => db.prepare(`INSERT INTO actors
    (id, workspace_id, type, handle, display_name, avatar_url, avatar_blob,
     owner_actor_id, state, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(`act_${Math.random()}`, 'wsp_1', over.type ?? 'human', `h${Math.random()}`,
         'Someone', null, null, null, over.state ?? 'active', 1);
  rejects(() => insert({ type: 'daemon' }), /CHECK constraint failed/);
  rejects(() => insert({ state: 'paused' }), /CHECK constraint failed/);
});

// ── spaces: the same policy matrix as the server ───────────────────────────

test('THE NULL TRAP: a channel with NULL visibility is rejected here too', () => {
  // The design records this trap against SQLite and the server test asserts it
  // against Postgres. Both engines, both schemas, same rule — asserted rather
  // than assumed to travel.
  const db = replica();
  rejects(() => insertSpace(db, { visibility: null }), /CHECK constraint failed/);
});

test('a channel with no name is rejected; a DM with no name is not', () => {
  const db = replica();
  rejects(() => insertSpace(db, { name: null }), /CHECK constraint failed/);
  insertSpace(db, { id: 'spc_dm', kind: 'dm', name: null, visibility: null,
                    membership_policy: 'sealed' });
});

test('a DM must be sealed and can never be archived', () => {
  const db = replica();
  rejects(() => insertSpace(db, { kind: 'dm', name: null, visibility: null,
                                  membership_policy: 'open' }), /CHECK constraint failed/);
  rejects(() => insertSpace(db, { kind: 'dm', name: null, visibility: null,
                                  membership_policy: 'sealed', lifecycle: 'archived' }),
          /CHECK constraint failed/);
});

// ── chats ──────────────────────────────────────────────────────────────────

function chatFixture(db: DatabaseSync, spaceId = 'spc_1') {
  insertSpace(db, { id: spaceId });
  db.prepare(`INSERT INTO chats (id, workspace_id, space_id, kind, name,
    created_by_actor_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run('cht_1', 'wsp_1', spaceId, 'sole', null, 'act_1', 1, 1);
  return 'cht_1';
}

test('chat_singleton rejects a second structural chat in one space', () => {
  const db = replica();
  chatFixture(db);
  rejects(() => db.prepare(`INSERT INTO chats (id, workspace_id, space_id, kind,
    name, created_by_actor_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run('cht_2', 'wsp_1', 'spc_1', 'default', null, 'act_1', 1, 1),
    /UNIQUE constraint failed/);
});

test('a chat cannot reference a space that does not exist', () => {
  // The one real foreign key in the replica: both sides of this pair arrive
  // together in `welcome`, so rejecting an orphan is right rather than racy.
  const db = replica();
  rejects(() => db.prepare(`INSERT INTO chats (id, workspace_id, space_id, kind,
    name, created_by_actor_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run('cht_x', 'wsp_1', 'spc_missing', 'sole', null, 'act_1', 1, 1),
    /FOREIGN KEY constraint failed/);
});

// ── messages: where the replica differs from the server ────────────────────

const insertMessage = (db: DatabaseSync, over: Record<string, unknown> = {}) => {
  const row = { id: 'msg_1', chat_id: 'cht_1', parent_id: null, ord: 1, rev: 1,
                author_id: 'act_1', body: 'hello', created_at: 1,
                state: 'acked', ...over };
  db.prepare(`INSERT INTO messages (id, chat_id, parent_id, ord, rev, author_id,
    body, created_at, state) VALUES (?,?,?,?,?,?,?,?,?)`).run(
    row.id as string, row.chat_id as string, row.parent_id as string | null,
    row.ord as number | null, row.rev as number | null, row.author_id as string,
    row.body as string, row.created_at as number, row.state as string);
};

test('MANY messages may have a NULL ordinal at once — several can be pending', () => {
  // The difference from the server, where ord is NOT NULL. A unique index that
  // was not partial would let exactly one message be pending per chat, which
  // breaks offline composition on the second message typed.
  const db = replica();
  chatFixture(db);
  insertMessage(db, { id: 'msg_a', ord: null, rev: null, state: 'pending' });
  insertMessage(db, { id: 'msg_b', ord: null, rev: null, state: 'pending' });
  insertMessage(db, { id: 'msg_c', ord: null, rev: null, state: 'pending' });
  const pending = db.prepare(
    `SELECT COUNT(*) n FROM messages WHERE state='pending'`).get() as { n: number };
  assert.equal(pending.n, 3);
});

test('but two ACKED messages may not share an ordinal', () => {
  const db = replica();
  chatFixture(db);
  insertMessage(db, { id: 'msg_a', ord: 5 });
  rejects(() => insertMessage(db, { id: 'msg_b', ord: 5 }), /UNIQUE constraint failed/);
});

test('a message may name an author who has not replicated yet', () => {
  // No FK on author_id, deliberately: the directory and the log are separate
  // streams. An FK here would reject the message rather than render an unknown
  // author, which is a worse answer to a race that is entirely normal.
  const db = replica();
  chatFixture(db);
  insertMessage(db, { author_id: 'act_stranger' });
  const row = db.prepare('SELECT author_id FROM messages').get() as { author_id: string };
  assert.equal(row.author_id, 'act_stranger');
});

test('message state is a closed set', () => {
  const db = replica();
  chatFixture(db);
  rejects(() => insertMessage(db, { state: 'sending' }), /CHECK constraint failed/);
});

// ── the sync cursor and its frontier ───────────────────────────────────────

test('chat_state starts at zero, so a new chat is behind rather than caught up', () => {
  const db = replica();
  db.prepare('INSERT INTO chat_state (chat_id) VALUES (?)').run('cht_1');
  const row = db.prepare(`SELECT head_ord, last_read_ord, chat_unread
    FROM chat_state WHERE chat_id='cht_1'`).get() as
    Record<string, number>;
  assert.deepEqual({ ...row }, { head_ord: 0, last_read_ord: 0, chat_unread: 0 });
  // oldest_local_ord is the one that is deliberately NULL: "we have never
  // evicted anything" is a different fact from "we hold from ordinal 0".
  const floor = db.prepare(
    `SELECT oldest_local_ord AS o FROM chat_state`).get() as { o: number | null };
  assert.equal(floor.o, null);
});

test('staged_events holds one row per rev per stream, and the envelope with it', () => {
  // Replaces `pending_revs`, which held only `(chat_id, rev)`. That shape loses
  // an event permanently — duplicate suppression drops it later as a duplicate
  // of a revision that was counted but never applied. The trace is in
  // `apply.test.ts`, reproduced against the old design so it cannot come back.
  const db = replica();
  db.prepare('INSERT INTO staged_events VALUES (?,?,?,?,?)')
    .run('chat', 'cht_1', 501, 'message.created', '{"id":"msg_1"}');
  db.prepare('INSERT INTO staged_events VALUES (?,?,?,?,?)')
    .run('chat', 'cht_1', 502, 'message.deleted', '{"id":"msg_1"}');

  rejects(() => db.prepare('INSERT INTO staged_events VALUES (?,?,?,?,?)')
    .run('chat', 'cht_1', 501, 'message.created', '{}'),
    /UNIQUE|PRIMARY KEY/);   // one row per revision per stream

  // Per STREAM, not per chat: a space and a chat may both be at revision 501.
  db.prepare('INSERT INTO staged_events VALUES (?,?,?,?,?)')
    .run('space', 'spc_1', 501, 'space.member_added', '{}');
  const n = db.prepare('SELECT COUNT(*) n FROM staged_events').get() as { n: number };
  assert.equal(n.n, 3);
  db.close();
});

test('stream_state is the ONE home for a frontier, whatever the stream', () => {
  // Chats had theirs in `chat_state`; spaces and the directory had nowhere, so
  // their events could not be applied at all. The apply loop must never have to
  // ask which table holds this stream's cursor — that question, asked in the
  // hottest correctness path, is where a silent hole comes from.
  const db = replica();
  for (const [kind, id] of [['chat', 'cht_1'], ['space', 'spc_1'],
                            ['workspace', 'wsp_1']] as const) {
    db.prepare('INSERT INTO stream_state (stream_kind, stream_id) VALUES (?,?)')
      .run(kind, id);
  }
  rejects(() => db.prepare('INSERT INTO stream_state (stream_kind, stream_id) VALUES (?,?)')
    .run('chat', 'cht_1'), /UNIQUE|PRIMARY KEY/);   // one cursor per stream

  const row = db.prepare(`SELECT synced_through_rev, server_head_rev, has_gap
    FROM stream_state WHERE stream_id='cht_1'`).get() as Record<string, number>;
  assert.deepEqual({ ...row },
    { synced_through_rev: 0, server_head_rev: 0, has_gap: 0 },
    'a stream never heard of is at zero, not null');
  db.close();
});

// ── the outbox ─────────────────────────────────────────────────────────────

const enqueue = (db: DatabaseSync, over: Record<string, unknown> = {}) => {
  const row = { op_id: 'op_1', seq: 1, kind: 'send', chat_id: 'cht_1',
                target_id: 'msg_1', payload: '{}', created_at: 1, ...over };
  db.prepare(`INSERT INTO outbox (op_id, seq, kind, chat_id, target_id, payload,
    created_at) VALUES (?,?,?,?,?,?,?)`).run(
    row.op_id as string, row.seq as number, row.kind as string,
    row.chat_id as string, row.target_id as string, row.payload as string,
    row.created_at as number);
};

test('outbox kinds are the ones this phase sends, and no more', () => {
  const db = replica();
  enqueue(db, { op_id: 'op_send', kind: 'send' });
  enqueue(db, { op_id: 'op_del', kind: 'delete' });
  enqueue(db, { op_id: 'op_read', kind: 'read' });
  // Widening this is Phase 4's job, and should be a deliberate edit.
  rejects(() => enqueue(db, { op_id: 'op_edit', kind: 'edit' }), /CHECK constraint failed/);
  rejects(() => enqueue(db, { op_id: 'op_react', kind: 'react' }), /CHECK constraint failed/);
});

test('an op queues once, and replay order is by seq rather than by id', () => {
  const db = replica();
  enqueue(db, { op_id: 'op_b', seq: 2 });
  enqueue(db, { op_id: 'op_a', seq: 1 });
  rejects(() => enqueue(db, { op_id: 'op_a', seq: 9 }), /UNIQUE constraint failed/);
  const order = (db.prepare('SELECT op_id FROM outbox ORDER BY seq').all() as
    { op_id: string }[]).map(r => r.op_id);
  assert.deepEqual(order, ['op_a', 'op_b'],
    'three messages typed offline must arrive in the order typed');
});

test('outbox state is a closed set', () => {
  const db = replica();
  rejects(() => db.prepare(`INSERT INTO outbox (op_id, seq, kind, chat_id,
    target_id, payload, created_at, state) VALUES (?,?,?,?,?,?,?,?)`)
    .run('op_x', 1, 'send', 'cht_1', 'msg_1', '{}', 1, 'sent'),
    /CHECK constraint failed/);
});

test('upgrading carries a chat cursor across into stream_state', () => {
  // The migration rebuilds `chat_state` and moves three columns out of it. A
  // replica that has already synced must keep its place — losing a frontier
  // here would silently re-fetch everything, or worse, leave the client
  // believing it holds history it discarded.
  const dir = mkdtempSync(join(tmpdir(), 'relayed-carry-'));
  const file = join(dir, 'relayed.db');

  const before = openDatabase(file);
  migrate(before, workspaceMigrations.filter(m => m.version <= 2));
  before.prepare(`INSERT INTO spaces (id, workspace_id, kind, name, slug, topic,
      visibility, membership_policy, created_by_actor_id, created_at, updated_at)
      VALUES ('spc_1','wsp_1','channel','general',NULL,NULL,'public','open',NULL,1,1)`).run();
  before.prepare(`INSERT INTO chats (id, workspace_id, space_id, kind, name,
      created_by_actor_id, created_at, updated_at)
      VALUES ('cht_1','wsp_1','spc_1','sole',NULL,NULL,1,1)`).run();
  before.prepare(`INSERT INTO chat_state
      (chat_id, synced_through_rev, server_head_rev, head_ord, last_read_ord,
       oldest_local_ord, chat_unread, has_gap)
      VALUES ('cht_1', 8134, 8140, 5521, 5000, 4000, 6, 1)`).run();
  before.close();

  const after = openDatabase(file);
  migrate(after, workspaceMigrations);

  const cursor = after.prepare(
    "SELECT * FROM stream_state WHERE stream_kind='chat' AND stream_id='cht_1'")
    .get() as Record<string, number>;
  assert.equal(cursor['synced_through_rev'], 8134, 'the frontier survived the rebuild');
  assert.equal(cursor['server_head_rev'], 8140);
  assert.equal(cursor['has_gap'], 1, 'and so did the gap marker');

  const state = after.prepare("SELECT * FROM chat_state WHERE chat_id='cht_1'")
    .get() as Record<string, number>;
  assert.equal(state['head_ord'], 5521, 'the chat-specific columns stayed put');
  assert.equal(state['last_read_ord'], 5000);
  assert.equal(state['oldest_local_ord'], 4000);
  assert.equal(state['chat_unread'], 6);
  assert.equal('synced_through_rev' in state, false, 'and the moved ones are gone');
  after.close();
});

test('a replica that reports version 7 without a drafts table gets one, and a correct one keeps its drafts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relayed-drafts-repair-'));
  try {
    // The development-era shape: version 7 applied, but it was not 'drafts'.
    const stale = openDatabase(join(dir, 'stale.db'));
    migrate(stale, workspaceMigrations.filter(m => m.version <= 6));
    stale.exec('ALTER TABLE messages ADD COLUMN parts TEXT; PRAGMA user_version = 7');
    assert.deepEqual(migrate(stale, workspaceMigrations).applied,
      ['8:drafts-repair', '9:gap-repair', '10:restricted-messages', '11:agent-summaries', '12:message-parts',
       '13:space-membership-markers', '14:connections', '15:room_panels', '16:space_attribution', '17:dm_members',
       '18:documents', '19:system_agents', '20:space_rosters'],
      'including 12, over the parts column this stale replica already has');
    stale.prepare("INSERT INTO drafts (chat_id, body, revision, updated_at) VALUES ('cht_1', 'hi', 1, 0)").run();
    stale.close();

    const right = openDatabase(join(dir, 'right.db'));
    migrate(right, workspaceMigrations.filter(m => m.version <= 7));
    right.prepare("INSERT INTO drafts (chat_id, body, revision, updated_at) VALUES ('cht_1', 'kept', 1, 0)").run();
    migrate(right, workspaceMigrations);
    assert.equal((right.prepare('SELECT body FROM drafts').get() as { body: string }).body, 'kept');
    right.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
