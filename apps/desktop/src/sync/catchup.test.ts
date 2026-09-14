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
import { setSink } from '@relayed/telemetry';
import {
  CatchupScheduler, applyCatchup, applyGap, applyBackfill, backfillFloor,
  applyRepair, applyThread, repairOwed,
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

// ─── the stall detector (step 13) ───────────────────────────────────────────

/** Say the server is ahead on a stream, without delivering anything. */
const serverAheadOn = (db: DatabaseSync, stream: Stream, rev: number): void => {
  db.prepare(`INSERT INTO stream_state (stream_kind, stream_id, server_head_rev)
              VALUES (?, ?, ?)
              ON CONFLICT(stream_kind, stream_id) DO UPDATE SET
                server_head_rev = excluded.server_head_rev`)
    .run(stream.kind, stream.id, rev);
};

/** The events one block emits, through the public sink. */
function recorded(fn: () => void): { name: string; fields: Record<string, unknown> }[] {
  const events: { name: string; fields: Record<string, unknown> }[] = [];
  setSink({
    event: (name, fields) =>
      events.push({ name, fields: fields as Record<string, unknown> }),
    count: () => {}, gauge: () => {}, histogram: () => {},
  });
  fn();
  return events;
}

test('BEHIND IS NOT STALLED — a client returning from a week off is healthy', () => {
  // The distinction the whole marker turns on. A client a hundred thousand
  // revisions behind is exactly what catch-up is for, and reporting it as a
  // stall would make the signal fire on the most ordinary event there is.
  const db = replica();
  const scheduler = new CatchupScheduler(db, () => {});
  serverAheadOn(db, CHAT, 100_000);

  const events = recorded(() => { scheduler.sweep(); });
  assert.equal(events.filter(e => e.name === 'sync.cursor.stalled').length, 0);
  db.close();
});

test('a frontier that does not move between sweeps IS stalled', () => {
  // Behind, not moving, and nothing in flight that could move it. Silent
  // otherwise: no error, no spinner, just a client that has quietly stopped
  // receiving messages (invariant 1).
  const db = replica();
  // A request that is never answered, so nothing ever settles or advances.
  const scheduler = new CatchupScheduler(db, () => {});
  serverAheadOn(db, CHAT, 500);

  scheduler.sweep();                      // first look: no memory to compare to
  scheduler.settled(CHAT);                // the reply came back and changed nothing
  const events = recorded(() => { scheduler.sweep(); });

  const stalled = events.find(e => e.name === 'sync.cursor.stalled');
  assert.ok(stalled, 'the stall was reported');
  assert.deepEqual(stalled.fields,
    { stream: 'chat', id: CHAT.id, cursor_rev: 0, head_rev: 500, lag: 500 });
  db.close();
});

test('a request still UNANSWERED is not stalled, it is waiting', () => {
  // The correction this definition took. Asking "is a request outstanding"
  // could not work: `settled` re-asks immediately while a stream is behind, so
  // a struggling stream is always outstanding and the signal would never fire.
  // Asking "were we answered" does — and it still stays quiet here.
  const db = replica();
  const scheduler = new CatchupScheduler(db, () => {});
  serverAheadOn(db, CHAT, 500);

  scheduler.sweep();                      // asked, and nothing has come back
  const events = recorded(() => { scheduler.sweep(); });
  assert.equal(events.filter(e => e.name === 'sync.cursor.stalled').length, 0);
  db.close();
});

test('THE STALL SURVIVES A RECONNECT, because the scheduler does not', () => {
  // Found by a load run, and it is the case the marker most needs to cover. The
  // memory started in the scheduler — which is rebuilt per connection, on
  // purpose — so a client reconnecting more often than it swept lost the
  // comparison every time and could sit permanently stuck reporting nothing.
  // A laptop on a flaky connection is both the likeliest to stall and the least
  // likely to stay connected long enough to notice.
  const db = replica();
  serverAheadOn(db, CHAT, 500);

  const first = new CatchupScheduler(db, () => {});
  first.sweep();
  first.settled(CHAT);

  // The socket dropped. A brand new scheduler, with nothing carried across.
  const second = new CatchupScheduler(db, () => {});
  second.sweep();          // welcome's sweep: no memory of its own, so quiet
  second.settled(CHAT);
  const events = recorded(() => { second.sweep(); });

  const stalled = events.find(e => e.name === 'sync.cursor.stalled');
  assert.ok(stalled, 'the mark outlived the connection');
  assert.equal(stalled.fields['cursor_rev'], 0);
  db.close();
});

test('a stream that caught up is FORGOTTEN, not remembered against itself', () => {
  // Otherwise the next time it fell behind by one event it would compare
  // against a frontier from before it caught up, and read as stalled on the
  // first sweep — a false alarm on the most normal thing that happens.
  const db = replica();
  const scheduler = new CatchupScheduler(db, () => {});
  const deps = { db, effect: replicaEffect() };

  serverAheadOn(db, CHAT, 1);
  scheduler.sweep();
  scheduler.settled(CHAT);
  applyEvent(deps, CHAT, created(1, 1));   // now level
  scheduler.sweep();

  serverAheadOn(db, CHAT, 2);              // behind again, by one
  const events = recorded(() => { scheduler.sweep(); });
  assert.equal(events.filter(e => e.name === 'sync.cursor.stalled').length, 0);
  db.close();
});

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
  applyGap(db, CHAT, 91_204, { kind: 'messages', head_ord: 40_112, recent: tail(40_063, 40_112) });

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

  applyGap(db, CHAT, 91_204, { kind: 'messages', head_ord: 40_112, recent: tail(40_100, 40_112) });
  assert.equal((db.prepare('SELECT COUNT(*) n FROM staged_events').get() as { n: number }).n, 0);
  db.close();
});

test('A SECOND GAP TAKES THE NEW TAIL\'S FLOOR, never the old one', () => {
  // This test used to assert the opposite — "the floor only ever goes down" —
  // and the sync model showed what that cost (WORKSPACE-AGENTS-IMPL.md §4.1.1):
  // a gap jumps over history this client never held, so an old, lower floor
  // promises that 40,000–40,189 are held when they are not. Kept at 40,000,
  // backfill only ever fetched below it, the 78 messages the second gap jumped
  // over never arrived, and `has_gap` cleared over the hole (invariant 86).
  const db = replica();
  applyGap(db, CHAT, 91_204, { kind: 'messages', head_ord: 40_112, recent: tail(40_000, 40_112) });
  assert.equal(backfillFloor(db, CHAT.id).oldestLocalOrd, 40_000);

  applyGap(db, CHAT, 91_300, { kind: 'messages', head_ord: 40_200, recent: tail(40_190, 40_200) });
  assert.equal(backfillFloor(db, CHAT.id).oldestLocalOrd, 40_190,
    'the floor is the second tail\'s: everything between is owed to backfill again');
  assert.equal(backfillFloor(db, CHAT.id).hasGap, true);

  // The rows held from before are still there — nothing was thrown away, and
  // backfill below 40,190 will re-send them harmlessly on its way down.
  assert.equal(messageCount(db), 113 + 11);
  db.close();
});

test('a gap after scrolling to the top still owes a backfill, and it can close', () => {
  // The first finding: floor 1, `has_gap` clear, then a gap. Before, the floor
  // stayed at 1 and nothing asked again; "more above" for ever.
  const db = replica();
  applyGap(db, CHAT, 100, { kind: 'messages', head_ord: 6, recent: tail(5, 6) });
  applyBackfill(db, CHAT.id, tail(1, 4), true);
  assert.deepEqual(backfillFloor(db, CHAT.id), { oldestLocalOrd: 1, headOrd: 6, hasGap: false });

  applyGap(db, CHAT, 300, { kind: 'messages', head_ord: 14, recent: tail(13, 14) });
  assert.deepEqual(backfillFloor(db, CHAT.id), { oldestLocalOrd: 13, headOrd: 14, hasGap: true },
    'the floor moved up to the new tail and the gap is open');
  applyBackfill(db, CHAT.id, tail(1, 12), true);
  assert.equal(backfillFloor(db, CHAT.id).hasGap, false);
  assert.equal(messageCount(db), 14, 'every message, including the six the gap jumped');
  db.close();
});

test('a gap whose tail is EMPTY for this reader has a null floor and still closes', () => {
  // Reachable once restricted messages exist: a reader who may see none of the
  // recent history. `link.ts` asks from just above the head and an empty page
  // marked complete is what clears the gap.
  const db = replica();
  applyGap(db, CHAT, 300, { kind: 'messages', head_ord: 14, recent: [] });
  assert.deepEqual(backfillFloor(db, CHAT.id), { oldestLocalOrd: null, headOrd: 14, hasGap: true });
  applyBackfill(db, CHAT.id, [], true);
  assert.equal(backfillFloor(db, CHAT.id).hasGap, false);
  db.close();
});

// ─── the version rule, and repair ───────────────────────────────────────────

/** A complete row, as the tail, backfill and repair all send one. */
const row = (ord: number, rev: number, extra: Partial<MessageRow> = {}): MessageRow => ({
  id: `msg_${ord}`, ord, rev, author_id: 'act_1', body: `body ${ord}`, parent_id: null,
  deleted: false, edited_at: null, reply_count: 0, ...extra,
});

const replyCreated = (rev: number, ord: number, parent: string): Envelope => ({
  rev, type: 'message.created',
  payload: {
    id: `msg_${ord}`, ord, parent_id: parent, author_id: 'act_2',
    body: `reply ${ord}`, created_at: '2026-09-10T16:04:11.238Z',
  },
});

const deletedEvent = (rev: number, id: string, parent: string | null = null): Envelope => ({
  rev, type: 'message.deleted', payload: { id, parent_id: parent },
});

const shown = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT deleted, body, reply_count, rev FROM messages WHERE id = ?').get(id) as
    { deleted: number; body: string; reply_count: number; rev: number } | undefined;

test('A GAP RECORDS THE REPAIR IT OWES: since the frontier it jumped from, up to the highest held', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  for (let i = 1; i <= 5; i++) applyEvent(deps, CHAT, created(i, i));
  assert.equal(repairOwed(db, CHAT.id), null, 'nothing owed while caught up');

  applyGap(db, CHAT, 900, { kind: 'messages', head_ord: 60, recent: tail(58, 60) });
  assert.deepEqual(repairOwed(db, CHAT.id), { sinceRev: 5, maxOrd: 5, after: null },
    'changes after revision 5, to messages at or below ordinal 5');
  db.close();
});

test('CAROL\'S WEEK: what changed while she was away is repaired, and only that', () => {
  // She held 1–10. Meanwhile 3 was edited, 5 gained two replies, 7 was
  // deleted, and forty more arrived. The repair page carries exactly 3, 5 and 7
  // as complete rows; applying it corrects her copies and touches nothing else.
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  for (let i = 1; i <= 10; i++) applyEvent(deps, CHAT, created(i, i));
  applyGap(db, CHAT, 900, { kind: 'messages', head_ord: 50, recent: tail(48, 50) });

  const page = [
    row(3, 11, { body: 'body 3, corrected', edited_at: '2026-09-11T10:00:00.000Z' }),
    row(5, 13, { reply_count: 2 }),
    row(7, 14, { deleted: true, body: '' }),
  ];
  const result = applyRepair(db, CHAT.id, page, true, { rev: 14, id: 'msg_7' });
  assert.deepEqual([result.done, result.rejected], [true, 0]);
  assert.equal(repairOwed(db, CHAT.id), null, 'a clean, complete page settles the debt');

  assert.equal(shown(db, 'msg_3')?.body, 'body 3, corrected', 'the edit');
  assert.equal(shown(db, 'msg_5')?.reply_count, 2, 'the replies');
  assert.deepEqual([shown(db, 'msg_7')?.deleted, shown(db, 'msg_7')?.body], [1, ''], 'the tombstone');
  assert.equal(shown(db, 'msg_1')?.body, 'body 1', 'the untouched, untouched');
  assert.equal(messageCount(db), 13, 'repair inserted nothing: history it never held is backfill\'s');
  db.close();
});

test('repair corrects only rows HELD: a row the client never had is not inserted', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyEvent(deps, CHAT, created(1, 1));
  applyGap(db, CHAT, 900, { kind: 'messages', head_ord: 50, recent: tail(50, 50) });
  applyRepair(db, CHAT.id, [row(30, 20, { deleted: true, body: '' })], true, { rev: 20, id: 'msg_30' });
  assert.equal(messageCount(db), 2, 'still just the one held row and the tail');
  db.close();
});

test('THE VERSION GUARD: a row older than what is held is rejected, and repair stays open', () => {
  // A live event landed between the server computing the page and this client
  // applying it. The live event is a delta over a stale row; the page is older
  // than the live event; neither alone is right. Rejecting the page and paging
  // on is what makes it right, because the live event bumped the server's row
  // past the cursor and it will be served again, complete (invariant 87).
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  for (let i = 1; i <= 5; i++) applyEvent(deps, CHAT, created(i, i));
  applyGap(db, CHAT, 900, { kind: 'messages', head_ord: 50, recent: tail(50, 50) });

  // A live reply to msg_4 lands at revision 901, bumping msg_4 locally.
  applyEvent(deps, CHAT, replyCreated(901, 51, 'msg_4'));
  assert.deepEqual([shown(db, 'msg_4')?.reply_count, shown(db, 'msg_4')?.rev], [1, 901]);

  // The repair page was computed before that: msg_4 at revision 700 with no
  // replies yet, and msg_2 deleted at 600.
  const page = [row(2, 600, { deleted: true, body: '' }), row(4, 700, { reply_count: 0 })];
  const result = applyRepair(db, CHAT.id, page, true, { rev: 700, id: 'msg_4' });
  assert.deepEqual([result.done, result.rejected], [false, 1], 'complete on the wire, but not done');
  assert.equal(shown(db, 'msg_4')?.reply_count, 1, 'the live reply was NOT wound back');
  assert.equal(shown(db, 'msg_2')?.deleted, 1, 'while the untouched row applied');
  assert.deepEqual(repairOwed(db, CHAT.id)?.after, { rev: 700, id: 'msg_4' }, 'paging continues from here');

  // The next page carries msg_4 again, at its new version, with the reply counted.
  const next = applyRepair(db, CHAT.id, [row(4, 901, { reply_count: 1 })], true, { rev: 901, id: 'msg_4' });
  assert.deepEqual([next.done, next.rejected], [true, 0]);
  assert.equal(repairOwed(db, CHAT.id), null);
  db.close();
});

test('a repair interrupted mid-way is PERSISTED, and a second gap WIDENS it', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  for (let i = 1; i <= 5; i++) applyEvent(deps, CHAT, created(i, i));
  applyGap(db, CHAT, 900, { kind: 'messages', head_ord: 50, recent: tail(50, 50) });
  applyRepair(db, CHAT.id, [row(2, 600, { deleted: true, body: '' })], false, { rev: 600, id: 'msg_2' });
  assert.deepEqual(repairOwed(db, CHAT.id), { sinceRev: 5, maxOrd: 5, after: { rev: 600, id: 'msg_2' } },
    'where it got to survives in the replica, so a quit resumes rather than forgets');

  // A second gap, from a frontier of 900 with ordinal 50 now held.
  applyGap(db, CHAT, 2000, { kind: 'messages', head_ord: 120, recent: tail(120, 120) });
  assert.deepEqual(repairOwed(db, CHAT.id), { sinceRev: 5, maxOrd: 50, after: null },
    'since the OLDER frontier, up to the NEWER highest held, paging restarted');
  db.close();
});

test('a reply moves its parent\'s count and version; a delete moves it back, held or not', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyEvent(deps, CHAT, created(1, 1));
  applyEvent(deps, CHAT, replyCreated(2, 2, 'msg_1'));
  assert.deepEqual([shown(db, 'msg_1')?.reply_count, shown(db, 'msg_1')?.rev], [1, 2]);

  // A reply this client never held — it learned the count from a fetched row —
  // deleted live: the event names the parent, so the count still moves.
  applyEvent(deps, CHAT, deletedEvent(3, 'msg_99', 'msg_1'));
  assert.equal(shown(db, 'msg_1')?.reply_count, 0, 'moved once, without the reply row');
  assert.equal(shown(db, 'msg_1')?.rev, 3);

  // A held reply deleted: marked, counted down once, and a duplicate delete
  // — already marked — does not count it down again.
  applyEvent(deps, CHAT, replyCreated(4, 4, 'msg_1'));
  applyEvent(deps, CHAT, deletedEvent(5, 'msg_4', 'msg_1'));
  assert.deepEqual([shown(db, 'msg_4')?.deleted, shown(db, 'msg_1')?.reply_count], [1, 0]);
  db.prepare("UPDATE stream_state SET synced_through_rev = 4 WHERE stream_id = ?").run(CHAT.id);
  applyEvent(deps, CHAT, deletedEvent(5, 'msg_4', 'msg_1'));
  assert.equal(shown(db, 'msg_1')?.reply_count, 0, 'never below what it should be');
  db.close();
});

test('tombstones from the tail and backfill mark held rows and are never un-deleted', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  for (let i = 1; i <= 3; i++) applyEvent(deps, CHAT, created(i, i));
  applyGap(db, CHAT, 900, { kind: 'messages', head_ord: 3, recent: [row(3, 800, { deleted: true, body: '' }), row(2, 2), row(1, 1)] });
  assert.equal(shown(db, 'msg_3')?.deleted, 1, 'the tail\'s tombstone applied to the held row');
  // An older copy of msg_3 from some stale page cannot bring it back.
  applyBackfill(db, CHAT.id, [row(3, 3)], false);
  assert.equal(shown(db, 'msg_3')?.deleted, 1, 'the version guard held');
  db.close();
});

test('a thread page inserts replies this client may see, and refreshes ones it holds', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyEvent(deps, CHAT, created(1, 1));
  applyEvent(deps, CHAT, replyCreated(2, 2, 'msg_1'));
  const topics = applyThread(db, CHAT.id, [
    row(2, 2, { parent_id: 'msg_1', body: 'reply 2' }),
    row(7, 7, { parent_id: 'msg_1', body: 'reply 7' }),
  ]);
  assert.deepEqual(topics, [`chat:${CHAT.id}:messages`]);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM messages WHERE parent_id = ?').get('msg_1') as { n: number }).n, 2);
  assert.deepEqual(applyThread(db, CHAT.id, []), [], 'an empty page wakes nothing');
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
  applyGap(db, CHAT, 91_204, { kind: 'messages', head_ord: 237, recent: tail(188, 237) });
  assert.equal(backfillFloor(db, CHAT.id).oldestLocalOrd, 188);

  applyBackfill(db, CHAT.id, tail(138, 187), false);
  const floor = backfillFloor(db, CHAT.id);
  assert.equal(floor.oldestLocalOrd, 138, 'the floor came down');
  assert.equal(floor.hasGap, true, 'and there is still more above the beginning');
  db.close();
});

test('the gap CLOSES when the server says the page was the last', () => {
  const db = replica();
  applyGap(db, CHAT, 91_204, { kind: 'messages', head_ord: 237, recent: tail(188, 237) });
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
  applyGap(db, CHAT, 91_204, { kind: 'messages', head_ord: 50, recent: tail(2, 50) });
  applyBackfill(db, CHAT.id, tail(1, 1), false);

  assert.equal(backfillFloor(db, CHAT.id).hasGap, false);
  db.close();
});

test('WITH ORDINAL 1 HIDDEN from this reader, the gap closes on complete alone', () => {
  // WORKSPACE-AGENTS.md §8.7, the client's has_gap rule. A restricted message at ordinal 1
  // is never sent here, so the floor stops at 2 and can never reach 1 — only
  // the server's `complete` can clear the gap, and it may only because the
  // server filtered it out before its LIMIT.
  const db = replica();
  applyGap(db, CHAT, 91_204, { kind: 'messages', head_ord: 60, recent: tail(11, 60) });
  applyBackfill(db, CHAT.id, tail(2, 10), true);

  const floor = backfillFloor(db, CHAT.id);
  assert.equal(floor.oldestLocalOrd, 2, 'the floor stops above the hidden ordinal');
  assert.equal(floor.hasGap, false, 'and the gap closed anyway, on the server\'s word');
  db.close();
});

test('a fetched row carries its list into the replica, and a live one keeps it', () => {
  const db = replica();
  const notice: MessageRow = { ...(tail(5, 5)[0] as MessageRow), visible_to: ['act_me', 'act_bob'] };
  applyGap(db, CHAT, 91_204, { kind: 'messages', head_ord: 5, recent: [...tail(3, 4), notice] });
  const rows = db.prepare('SELECT ord, visible_to FROM messages ORDER BY ord').all();
  assert.deepEqual(rows.map(r => ({ ...r })), [
    { ord: 3, visible_to: null }, { ord: 4, visible_to: null },
    { ord: 5, visible_to: '["act_me","act_bob"]' },
  ]);
  db.close();
});

test('paging terminates without duplicates or holes', () => {
  // Keyset on `ord`, never OFFSET: offset paging degrades linearly and, worse,
  // skips or repeats rows when anything is inserted mid-scroll.
  const db = replica();
  applyGap(db, CHAT, 91_204, { kind: 'messages', head_ord: 237, recent: tail(188, 237) });

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
  applyGap(db, CHAT, 91_204, { kind: 'messages', head_ord: 237, recent: tail(188, 237) });
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
  applyGap(db, CHAT, 100, { kind: 'messages', head_ord: 50, recent: tail(1, 50) });

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

// ─── agents in the directory (WORKSPACE-AGENTS.md §4.5) ─────────────────────

const agentPayload = {
  id: 'act_triage', type: 'agent', handle: 'triage', display_name: 'Triage', avatar_url: null,
  owner_actor_id: 'act_alice', state: 'active',
  agent: { description: 'Files bugs', config_rev: 2, toolkits: [{ toolkit: 'linear', effect: 'write' }] },
};

const summaryOf = (db: DatabaseSync, id: string) =>
  ({ ...(db.prepare('SELECT description, config_rev, toolkits FROM agent_summaries WHERE actor_id = ?')
    .get(id) as Record<string, unknown>) });

test('AN AGENT CREATED LIVE applies: the owner rides the event, and the summary lands beside the row', () => {
  // The bug this fixes: the effect wrote a NULL owner, the replica's CHECK
  // refuses that for an agent, and the event threw — so an agent created while
  // a client was connected never reached that client's autocomplete.
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  const applied = applyEvent(deps, WORKSPACE, { rev: 1, type: 'actor.created', payload: agentPayload });

  assert.equal(applied.outcome, 'applied');
  const row = db.prepare('SELECT type, owner_actor_id FROM actors WHERE id = ?').get('act_triage');
  assert.deepEqual({ ...row }, { type: 'agent', owner_actor_id: 'act_alice' });
  assert.deepEqual(summaryOf(db, 'act_triage'),
    { description: 'Files bugs', config_rev: 2, toolkits: '[{"toolkit":"linear","effect":"write"}]' });

  applyEvent(deps, WORKSPACE, { rev: 2, type: 'actor.updated',
    payload: { ...agentPayload, agent: { ...agentPayload.agent, description: 'Files and dedupes', config_rev: 3 } } });
  assert.equal(summaryOf(db, 'act_triage')['description'], 'Files and dedupes', 'an update replaces it');
  db.close();
});

test('a person from a server that predates the owner field still applies', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  assert.equal(applyEvent(deps, WORKSPACE, actorEvent(1, 'act_old')).outcome, 'applied');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_summaries').get()?.['n'], 0, 'and a person has no summary');
  db.close();
});

test('a DIRECTORY PAGE stores an agent\'s summary with its row', () => {
  const db = replica();
  applyDirectoryPage(db, WORKSPACE.id, [
    person('act_alice'),
    { ...person('act_triage'), type: 'agent', owner_actor_id: 'act_alice', agent: agentPayload.agent },
  ]);
  assert.equal(summaryOf(db, 'act_triage')['config_rev'], 2);
  db.close();
});
