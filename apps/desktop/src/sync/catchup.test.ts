// Catch-up, the gap, and backfill — step 9 of the sync build plan.
//
// The property that binds all three: a reconnect costs O(streams), not
// O(messages). A person away for a week across 150 chats gets one small frame
// each rather than a hundred thousand messages, and everything below the tail
// is missing-and-MARKED rather than missing-and-unknown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate.ts';
import { workspaceMigrations } from './migrations/workspace.ts';
import { applyEvent, frontierOf, type Stream, type Envelope } from './apply.ts';
import { replicaEffect } from './effects.ts';
import {
  CatchupScheduler, applyCatchup, applyGap, applyBackfill, backfillFloor,
  applyDirectoryPage, directorySnapshotComplete, directoryOwed,
  type MessageRow, type DirectoryRow,
} from './catchup.ts';

const CHAT: Stream = { kind: 'chat', id: 'cht_eng' };
const SPACE: Stream = { kind: 'space', id: 'spc_eng' };

function replica(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db, workspaceMigrations);
  return db;
}

const created = (rev: number, ord: number): Envelope => ({
  rev, type: 'message.created',
  payload: {
    id: `msg_${ord}`, ord, parent_id: null, author_id: 'act_1',
    body: `body ${ord}`, created_at: '2026-09-10T16:04:11.238Z',
  },
});

const tail = (from: number, to: number): MessageRow[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    id: `msg_${from + i}`, ord: from + i, rev: 90_000 + from + i,
    author_id: 'act_1', body: `body ${from + i}`, parent_id: null,
  }));

const messageCount = (db: DatabaseSync): number =>
  (db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n;

// ─── the scheduler ──────────────────────────────────────────────────────────

test('a hundred staged arrivals produce ONE catch-up request', () => {
  // Coalesced, not one per hole. The answer to all of them is the same range,
  // and asking each time turns a client that fell behind into a client that is
  // hammering the server about it.
  const db = replica();
  const asked: { stream: Stream; from: number }[] = [];
  const scheduler = new CatchupScheduler(db, (stream, from) => asked.push({ stream, from }));
  const deps = { db, effect: replicaEffect() };

  applyEvent(deps, CHAT, created(1, 1));
  for (let rev = 3; rev < 103; rev++) {
    const result = applyEvent(deps, CHAT, created(rev, rev));
    if (result.needsCatchup) scheduler.want(CHAT);
  }

  assert.equal(asked.length, 1, 'one request, not a hundred');
  assert.equal(asked[0]?.from, 1, 'and it asks from the FRONTIER, not the head');
  db.close();
});

test('an arrival while a request is out asks exactly once more', () => {
  // Not zero, which leaves the client behind for ever; and not a queue, which
  // is the same storm with a delay.
  const db = replica();
  const asked: number[] = [];
  const scheduler = new CatchupScheduler(db, (_s, from) => asked.push(from));
  const deps = { db, effect: replicaEffect() };
  applyEvent(deps, CHAT, created(1, 1));

  scheduler.want(CHAT);                 // request goes out
  scheduler.want(CHAT);                 // arrives while it is in flight
  scheduler.want(CHAT);                 // and again
  assert.equal(asked.length, 1);

  scheduler.settled(CHAT);              // the reply lands
  assert.equal(asked.length, 2, 'exactly one follow-up, however many arrived');
  db.close();
});

test('a settled request that left the stream still behind asks again', () => {
  // Driven by the DATABASE rather than by what the reply said. A truncated
  // batch leaves the stream behind by construction, and a client that trusted
  // "a reply arrived" would stop one round short for ever.
  const db = replica();
  const asked: number[] = [];
  const scheduler = new CatchupScheduler(db, (_s, from) => asked.push(from));
  const deps = { db, effect: replicaEffect() };

  applyEvent(deps, CHAT, created(1, 1));
  applyEvent(deps, CHAT, created(50, 50));   // records a head of 50
  scheduler.want(CHAT);
  assert.deepEqual(asked, [1]);

  scheduler.settled(CHAT);
  assert.deepEqual(asked, [1, 1], 'still behind, so it asks again');
  db.close();
});

test('a stream that is caught up is not asked about', () => {
  const db = replica();
  const asked: Stream[] = [];
  const scheduler = new CatchupScheduler(db, stream => asked.push(stream));
  const deps = { db, effect: replicaEffect() };

  applyEvent(deps, CHAT, created(1, 1));
  applyEvent(deps, SPACE, { rev: 1, type: 'space.created', payload: {} });
  applyEvent(deps, CHAT, created(9, 9));     // a hole, only on the chat

  scheduler.sweep();
  assert.deepEqual(asked.map(s => s.id), ['cht_eng'], 'the space is level');
  db.close();
});

// ─── applying a reply ───────────────────────────────────────────────────────

test('a catch-up reply applies in order and advances the frontier', async () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  const result = await applyCatchup(deps, CHAT,
    [created(1, 1), created(2, 2), created(3, 3)]);

  assert.equal(frontierOf(db, CHAT), 3);
  assert.ok(result.topics.includes('chat:cht_eng:messages'));
  assert.equal(result.needsCatchup, false);
  db.close();
});

test('a large reply is applied in CHUNKS, not one transaction', async () => {
  // WAL lets readers proceed during writes, but one transaction holding the
  // writer for fifty thousand events blocks every other write — so the queries
  // a visible surface is making wait behind it. Catching up should look like a
  // sidebar filling in, not an application that stops answering.
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  const events = Array.from({ length: 1_000 }, (_, i) => created(i + 1, i + 1));

  let yields = 0;
  const realImmediate = globalThis.setImmediate;
  (globalThis as { setImmediate: typeof setImmediate }).setImmediate =
    ((fn: () => void) => { yields++; return realImmediate(fn); }) as typeof setImmediate;
  try {
    await applyCatchup(deps, CHAT, events, 200);
  } finally {
    (globalThis as { setImmediate: typeof setImmediate }).setImmediate = realImmediate;
  }

  assert.equal(frontierOf(db, CHAT), 1_000);
  assert.equal(messageCount(db), 1_000);
  assert.equal(yields, 4, 'five chunks of two hundred, yielding between them');
  db.close();
});

test('a reader can query DURING a large catch-up', async () => {
  // The property the chunking exists for, asserted as latency rather than as a
  // count of transactions. Measured on the reader, not on the writer — a
  // catch-up that finishes quickly while the UI is frozen has failed.
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  const events = Array.from({ length: 3_000 }, (_, i) => created(i + 1, i + 1));

  let worst = 0;
  let reads = 0;
  const reader = setInterval(() => {
    const at = performance.now();
    db.prepare('SELECT COUNT(*) FROM messages WHERE chat_id = ?').get(CHAT.id);
    worst = Math.max(worst, performance.now() - at);
    reads++;
  }, 1);

  await applyCatchup(deps, CHAT, events, 200);
  clearInterval(reader);

  assert.ok(reads > 3, `the reader actually ran (${reads} times)`);
  assert.ok(worst < 100, `worst read during catch-up was ${worst.toFixed(1)}ms`);
  db.close();
});

// ─── the gap ────────────────────────────────────────────────────────────────

test('a gap adopts the tail, jumps the frontier, and MARKS the floor', () => {
  // Jumping past revisions never seen is safe precisely because the tail is
  // current state rather than partial history. What is below is not
  // missing-and-unknown — it is missing-and-marked.
  const db = replica();
  applyGap(db, CHAT, 91_204, { kind: 'messages', headOrd: 40_112, recent: tail(40_063, 40_112) });

  assert.equal(frontierOf(db, CHAT), 91_204, 'the frontier jumped deliberately');
  assert.equal(messageCount(db), 50, 'and only the tail came with it');

  const floor = backfillFloor(db, CHAT.id);
  assert.equal(floor.hasGap, true, 'the floor is MARKED');
  assert.equal(floor.oldestLocalOrd, 40_063, 'and says exactly where it is');
  db.close();
});

test('a gap CLEARS staged events, which could never drain', () => {
  // They are all below the new frontier now, so nothing will ever reach them.
  // Left behind they would sit there for ever, and the table's whole claim is
  // that it collapses to empty whenever the client is caught up.
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyEvent(deps, CHAT, created(1, 1));
  applyEvent(deps, CHAT, created(40, 40));
  applyEvent(deps, CHAT, created(41, 41));
  assert.ok((db.prepare('SELECT COUNT(*) n FROM staged_events').get() as { n: number }).n > 0);

  applyGap(db, CHAT, 91_204, { kind: 'messages', headOrd: 40_112, recent: tail(40_100, 40_112) });
  assert.equal((db.prepare('SELECT COUNT(*) n FROM staged_events').get() as { n: number }).n, 0);
  db.close();
});

test('a second gap with a shorter tail does not RAISE the floor', () => {
  // `oldest_local_ord` only ever goes down. Raising it would hide history the
  // client already holds, and the UI would offer to backfill what is already
  // there while pretending the rest is gone.
  const db = replica();
  applyGap(db, CHAT, 91_204, { kind: 'messages', headOrd: 40_112, recent: tail(40_000, 40_112) });
  assert.equal(backfillFloor(db, CHAT.id).oldestLocalOrd, 40_000);

  applyGap(db, CHAT, 91_300, { kind: 'messages', headOrd: 40_200, recent: tail(40_190, 40_200) });
  assert.equal(backfillFloor(db, CHAT.id).oldestLocalOrd, 40_000, 'the floor held');
  db.close();
});

test('a gap on a SPACE carries no message tail and still works', () => {
  // The snapshot is discriminated by stream kind because "what do I render
  // while behind" has a different answer for each. A message tail is
  // meaningless for a stream that carries none.
  const db = replica();
  const topics = applyGap(db, SPACE, 42, { kind: 'space' });

  assert.equal(frontierOf(db, SPACE), 42);
  assert.equal(messageCount(db), 0, 'nothing was invented');
  assert.deepEqual(topics, ['space:spc_eng']);
  db.close();
});

test('a gap on the DIRECTORY records the debt without inlining it', () => {
  // At 1,600 members the directory is 345 KB — the exact collection invariant
  // 71 exists to keep out of a frame. The gap says only that it must be paged.
  const db = replica();
  const workspace: Stream = { kind: 'workspace', id: 'wsp_1' };
  applyGap(db, workspace, 4_821, { kind: 'directory' });

  assert.equal(frontierOf(db, workspace), 4_821);
  const row = db.prepare(`SELECT has_gap FROM stream_state
    WHERE stream_kind='workspace' AND stream_id='wsp_1'`).get() as { has_gap: number };
  assert.equal(row.has_gap, 1, 'marked, so the paged fetch knows it is owed');
  db.close();
});

// ─── backfill ───────────────────────────────────────────────────────────────

test('backfill lowers the floor and keeps the gap open until the beginning', () => {
  const db = replica();
  applyGap(db, CHAT, 91_204, { kind: 'messages', headOrd: 237, recent: tail(188, 237) });
  assert.equal(backfillFloor(db, CHAT.id).oldestLocalOrd, 188);

  applyBackfill(db, CHAT.id, tail(138, 187), false);
  const floor = backfillFloor(db, CHAT.id);
  assert.equal(floor.oldestLocalOrd, 138, 'the floor came down');
  assert.equal(floor.hasGap, true, 'and there is still more above the beginning');
  db.close();
});

test('the gap CLOSES when the server says the page was the last', () => {
  const db = replica();
  applyGap(db, CHAT, 91_204, { kind: 'messages', headOrd: 237, recent: tail(188, 237) });
  applyBackfill(db, CHAT.id, tail(1, 187), true);

  const floor = backfillFloor(db, CHAT.id);
  assert.equal(floor.oldestLocalOrd, 1);
  assert.equal(floor.hasGap, false, 'the whole history is held');
  assert.equal(messageCount(db), 237);
  db.close();
});

test('the gap ALSO closes on reaching ordinal 1, not only on being told', () => {
  // Clearing on "no rows returned" alone would clear it on a network hiccup
  // too. Reaching the first ordinal is positive evidence rather than an absence.
  const db = replica();
  applyGap(db, CHAT, 91_204, { kind: 'messages', headOrd: 50, recent: tail(2, 50) });
  applyBackfill(db, CHAT.id, tail(1, 1), false);

  assert.equal(backfillFloor(db, CHAT.id).hasGap, false);
  db.close();
});

test('paging terminates without duplicates or holes', () => {
  // Keyset on `ord`, never OFFSET: offset paging degrades linearly and, worse,
  // skips or repeats rows when anything is inserted mid-scroll.
  const db = replica();
  applyGap(db, CHAT, 91_204, { kind: 'messages', headOrd: 237, recent: tail(188, 237) });

  let cursor = backfillFloor(db, CHAT.id).oldestLocalOrd ?? 0;
  let pages = 0;
  while (cursor > 1) {
    const from = Math.max(1, cursor - 50);
    applyBackfill(db, CHAT.id, tail(from, cursor - 1), from === 1);
    cursor = backfillFloor(db, CHAT.id).oldestLocalOrd ?? 1;
    pages++;
    assert.ok(pages < 10, 'paging terminated');
  }

  assert.equal(messageCount(db), 237, 'the whole history, once each');
  assert.equal(backfillFloor(db, CHAT.id).hasGap, false);
  db.close();
});

test('an empty backfill page on an open gap changes nothing', () => {
  // A hiccup is not evidence of the beginning.
  const db = replica();
  applyGap(db, CHAT, 91_204, { kind: 'messages', headOrd: 237, recent: tail(188, 237) });
  const before = backfillFloor(db, CHAT.id);

  applyBackfill(db, CHAT.id, [], false);
  assert.deepEqual(backfillFloor(db, CHAT.id), before, 'the floor and the gap held');
  db.close();
});

// ─── after a gap, live events still work ────────────────────────────────────

test('a live event after a gap applies at the new frontier', () => {
  // The gap left the frontier at the head, so the very next event is
  // frontier + 1 and applies normally — no special case for "we just gapped".
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyGap(db, CHAT, 100, { kind: 'messages', headOrd: 50, recent: tail(1, 50) });

  const next = applyEvent(deps, CHAT, created(101, 51));
  assert.equal(next.outcome, 'applied');
  assert.equal(frontierOf(db, CHAT), 101);
  db.close();
});

// ─── the directory ──────────────────────────────────────────────────────────

const WORKSPACE: Stream = { kind: 'workspace', id: 'wsp_1' };

const person = (id: string, over: Partial<DirectoryRow> = {}): DirectoryRow => ({
  id, type: 'human', handle: id.slice(-4), display_name: `Person ${id.slice(-4)}`,
  avatar_url: null, owner_actor_id: null, state: 'active', updated_at: 1, ...over,
});

const actorEvent = (rev: number, id: string, over: Record<string, unknown> = {}): Envelope => ({
  rev, type: 'actor.updated',
  payload: {
    id, type: 'human', handle: id.slice(-4), display_name: `Person ${id.slice(-4)}`,
    avatar_url: null, state: 'active', ...over,
  },
});

const nameOf = (db: DatabaseSync, id: string): string | undefined =>
  (db.prepare('SELECT display_name FROM actors WHERE id = ?').get(id) as
    { display_name: string } | undefined)?.display_name;

test('a reconnect two revisions behind applies TWO rows, not sixteen hundred', () => {
  // The entire reason the directory is a stream rather than an array in
  // `welcome`. Re-sending replicated state that changes rarely is the worst
  // possible shape: maximum bytes, minimum information.
  const db = replica();
  const deps = { db, effect: replicaEffect() };

  applyDirectoryPage(db, WORKSPACE.id,
    Array.from({ length: 1_600 }, (_, i) => person(`act_${String(i).padStart(5, '0')}`)));
  directorySnapshotComplete(db, WORKSPACE.id, 4_819);

  applyEvent(deps, WORKSPACE, actorEvent(4_820, 'act_00007', { display_name: 'Renamed' }));
  applyEvent(deps, WORKSPACE, actorEvent(4_821, 'act_99999'));

  assert.equal(nameOf(db, 'act_00007'), 'Renamed', 'the rename landed');
  assert.equal(nameOf(db, 'act_99999'), 'Person 9999', 'and the new arrival');
  assert.equal(frontierOf(db, WORKSPACE), 4_821);
  assert.equal(
    (db.prepare('SELECT COUNT(*) n FROM actors').get() as { n: number }).n, 1_601);
  db.close();
});

test('a directory page does NOT delete what it did not contain', () => {
  // The difference from the HTTP directory this replaced: that was a whole
  // snapshot in one response and could treat absence as removal. A PAGE cannot
  // — an actor missing from page two is on page one.
  const db = replica();
  applyDirectoryPage(db, WORKSPACE.id, [person('act_1'), person('act_2')]);
  applyDirectoryPage(db, WORKSPACE.id, [person('act_3')]);

  assert.equal(
    (db.prepare('SELECT COUNT(*) n FROM actors').get() as { n: number }).n, 3,
    'all three survived');
  db.close();
});

test('the cursor is adopted only after the LAST page', () => {
  // Adopting it after page one would leave the client believing it held a
  // directory it had only started fetching — and every actor on later pages
  // missing until they happened to change.
  const db = replica();
  applyDirectoryPage(db, WORKSPACE.id, [person('act_1')]);
  assert.equal(frontierOf(db, WORKSPACE), 0, 'a page alone advances nothing');
  assert.equal(directoryOwed(db, WORKSPACE.id), true, 'still owed');

  directorySnapshotComplete(db, WORKSPACE.id, 4_821);
  assert.equal(frontierOf(db, WORKSPACE), 4_821);
  assert.equal(directoryOwed(db, WORKSPACE.id), false, 'and settled');
  db.close();
});

test('a fresh device owes a directory; one that has it does not', () => {
  const db = replica();
  assert.equal(directoryOwed(db, WORKSPACE.id), true, 'no row at all is the same as zero');

  directorySnapshotComplete(db, WORKSPACE.id, 4_821);
  assert.equal(directoryOwed(db, WORKSPACE.id), false);

  applyGap(db, WORKSPACE, 9_000, { kind: 'directory' });
  assert.equal(directoryOwed(db, WORKSPACE.id), true, 'a gap owes one again');
  db.close();
});

test('a DEACTIVATED actor is updated, never removed', () => {
  // Their past messages still have to render. A client that dropped the row
  // would show an empty name where a greyed one belongs (DESIGN.md §6.3).
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyDirectoryPage(db, WORKSPACE.id, [person('act_1')]);
  directorySnapshotComplete(db, WORKSPACE.id, 10);

  applyEvent(deps, WORKSPACE, actorEvent(11, 'act_1', { state: 'deactivated' }));

  const row = db.prepare('SELECT display_name, state FROM actors WHERE id = ?')
    .get('act_1') as { display_name: string; state: string };
  assert.equal(row.state, 'deactivated');
  assert.equal(row.display_name, 'Person ct_1', 'the name survived, so it can be greyed');
  db.close();
});

test('an avatar already fetched survives a directory update, and drops on a new url', () => {
  // The bytes we hold are the OLD url's. Keeping the pointer across a change
  // renders yesterday's picture; dropping it on every update makes prefetching
  // pointless. Same rule the HTTP directory used, for the same reason.
  const db = replica();
  applyDirectoryPage(db, WORKSPACE.id, [person('act_1', { avatar_url: 'https://a/1.png' })]);
  db.prepare("UPDATE actors SET avatar_blob = 'deadbeef' WHERE id = 'act_1'").run();

  applyDirectoryPage(db, WORKSPACE.id, [
    person('act_1', { avatar_url: 'https://a/1.png', display_name: 'Renamed' })]);
  let row = db.prepare('SELECT avatar_blob FROM actors WHERE id = ?').get('act_1') as
    { avatar_blob: string | null };
  assert.equal(row.avatar_blob, 'deadbeef', 'same url, bytes kept');

  applyDirectoryPage(db, WORKSPACE.id, [person('act_1', { avatar_url: 'https://a/2.png' })]);
  row = db.prepare('SELECT avatar_blob FROM actors WHERE id = ?').get('act_1') as
    { avatar_blob: string | null };
  assert.equal(row.avatar_blob, null, 'new url, bytes dropped for the prefetch to refill');
  db.close();
});

test('THE MONOGRAM WINDOW: an author renders before their row lands', () => {
  // The product consequence, named rather than discovered. On a FRESH device,
  // between first paint and the last directory page, a message author has no
  // name — the same fallback avatars already use, and the price of not blocking
  // the first frame on a collection sized by the company.
  //
  // Asserted as a JOIN that survives the absence, because the failure mode is
  // not "no name" — it is an inner join that drops the message entirely.
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyEvent(deps, CHAT, created(1, 1));

  const row = db.prepare(`
    SELECT m.id, m.body, a.display_name
      FROM messages m LEFT JOIN actors a ON a.id = m.author_id
     WHERE m.chat_id = ?`).get(CHAT.id) as
    { id: string; body: string; display_name: string | null };

  assert.equal(row.body, 'body 1', 'the message renders');
  assert.equal(row.display_name, null, 'with no name yet — a monogram, not a gap');

  applyDirectoryPage(db, WORKSPACE.id, [person('act_1', { display_name: 'Harsh Sharma' })]);
  const named = db.prepare(`
    SELECT a.display_name FROM messages m LEFT JOIN actors a ON a.id = m.author_id
     WHERE m.chat_id = ?`).get(CHAT.id) as { display_name: string | null };
  assert.equal(named.display_name, 'Harsh Sharma', 'and the name arrives after');
  db.close();
});
