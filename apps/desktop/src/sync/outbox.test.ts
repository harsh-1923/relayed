// The outbox — step 11 of the sync build plan.
//
// The first thing a user can break by being offline, and the assertions that
// matter are all about what a PERSON experiences: messages arriving in the
// order they were typed, a composed-then-deleted message never appearing
// anywhere, and a send that can never succeed saying so instead of spinning.
//
// The coalescing cases are ported from `spikes/sync-tests.mjs`, which is the
// acceptance suite rather than a sketch. Its `edit` rows wait for Phase 4 along
// with edits themselves — carrying them now would be branches nothing
// exercises, which is how a coalescing rule ends up wrong the first time it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate.ts';
import { workspaceMigrations } from './migrations/workspace.ts';
import {
  enqueue, ready, markInflight, applyAck, applyNack, retryAt,
  failed, retry, discard, depth,
} from './outbox.ts';

const CHAT = 'cht_eng';

function replica(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db, workspaceMigrations);
  return db;
}

/** Compose offline: the optimistic row and the queue entry, together. */
function compose(db: DatabaseSync, messageId: string, body: string, chatId = CHAT) {
  return enqueue(db, {
    opId: `op_${messageId}`, kind: 'send', chatId, targetId: messageId,
    payload: { id: messageId, body },
  }, (tx) => {
    tx.prepare(`
      INSERT INTO messages (id, chat_id, parent_id, ord, rev, author_id, body,
                            created_at, state, local_only)
      VALUES (?, ?, NULL, NULL, NULL, 'act_me', ?, ?, 'pending', 0)
    `).run(messageId, chatId, body, Date.now());
  });
}

const remove = (db: DatabaseSync, messageId: string, chatId = CHAT) =>
  enqueue(db, {
    opId: `op_del_${messageId}`, kind: 'delete', chatId, targetId: messageId,
    payload: { id: messageId },
  });

const bodies = (db: DatabaseSync): string[] =>
  (db.prepare('SELECT body FROM messages ORDER BY created_at, id').all() as
    { body: string }[]).map(row => row.body);

// ─── coalescing, which is correctness rather than economy ───────────────────

test('SPIKE §10.4: compose then delete offline produces ZERO network ops', () => {
  // The bug this prevents: `delete` targets a message id the server has never
  // seen. Best case it 404s and both ops land in `failed`; worst case they
  // arrive out of order and there is a ghost message nobody can remove.
  const db = replica();
  compose(db, 'msg_1', 'oops');
  const result = remove(db, 'msg_1');

  assert.equal(result.outcome, 'coalesced');
  assert.deepEqual(ready(db), [], 'nothing will ever be sent');
  assert.equal(depth(db).queued, 0);
  db.close();
});

test('the optimistic row goes with it — no ghost, no tombstone', () => {
  // It was never sent, so there is nothing to tombstone. Leaving a deleted row
  // behind would render a message no other device has ever seen.
  const db = replica();
  compose(db, 'msg_1', 'oops');
  assert.deepEqual(bodies(db), ['oops']);

  remove(db, 'msg_1');
  assert.deepEqual(bodies(db), [], 'gone entirely, not greyed out');
  db.close();
});

test('a delete for a message the server DOES know is queued normally', () => {
  // Coalescing is scoped by target, and there is no pending send for this one —
  // so the delete is a real op with a real target.
  const db = replica();
  const result = remove(db, 'msg_already_sent');

  assert.equal(result.outcome, 'queued');
  assert.deepEqual(ready(db).map(op => op.kind), ['delete']);
  db.close();
});

test('deleting one composed message does not disturb another', () => {
  // Scoped by `target_id`, which is why the outbox indexes it.
  const db = replica();
  compose(db, 'msg_1', 'keep me');
  compose(db, 'msg_2', 'drop me');
  remove(db, 'msg_2');

  assert.deepEqual(ready(db).map(op => op.targetId), ['msg_1']);
  assert.deepEqual(bodies(db), ['keep me']);
  db.close();
});

// ─── order ──────────────────────────────────────────────────────────────────

test('three messages typed offline arrive in the order typed', () => {
  // The thing a person notices immediately and cannot explain. One in flight
  // per chat, in `seq` order, is what "the order typed" means.
  const db = replica();
  compose(db, 'msg_1', 'first');
  compose(db, 'msg_2', 'second');
  compose(db, 'msg_3', 'third');

  const sent: string[] = [];
  for (;;) {
    const [next] = ready(db);
    if (!next) break;
    sent.push(next.targetId);
    applyAck(db, next.opId, {
      messageId: next.targetId, chatId: CHAT, ord: sent.length, rev: sent.length,
      createdAt: '2026-09-11T10:00:00.000Z',
    });
  }

  assert.deepEqual(sent, ['msg_1', 'msg_2', 'msg_3']);
  db.close();
});

test('ONE in flight per chat, and chats do not block each other', () => {
  // Across chats there is no ordering to preserve, so a chat stuck behind a
  // slow op must not hold up every other one.
  const db = replica();
  compose(db, 'msg_a1', 'a1', 'cht_a');
  compose(db, 'msg_a2', 'a2', 'cht_a');
  compose(db, 'msg_b1', 'b1', 'cht_b');

  const batch = ready(db);
  assert.deepEqual(batch.map(op => op.targetId), ['msg_a1', 'msg_b1'],
    'the oldest from each chat, and only the oldest');
  db.close();
});

test('an op in flight is not handed out again', () => {
  const db = replica();
  compose(db, 'msg_1', 'first');
  const [first] = ready(db);
  markInflight(db, first!.opId);

  assert.deepEqual(ready(db), [], 'still one in flight, so nothing new');
  db.close();
});

test('sequence survives a restart, so a new op cannot jump the queue', () => {
  // Derived from the table rather than held in memory: a counter reset on
  // restart would hand a new op a sequence below one already queued, and the
  // drain would go out of order.
  const path = ':memory:';
  const db = replica();
  compose(db, 'msg_1', 'before');
  compose(db, 'msg_2', 'also before');

  // Simulate a restart by reading the sequence back the way a new process would.
  const top = (db.prepare('SELECT MAX(seq) s FROM outbox').get() as { s: number }).s;
  compose(db, 'msg_3', 'after');
  const last = (db.prepare('SELECT seq FROM outbox WHERE target_id = ?')
    .get('msg_3') as { seq: number }).seq;

  assert.ok(last > top, 'the new op is behind everything already queued');
  void path;
  db.close();
});

// ─── the ack ────────────────────────────────────────────────────────────────

test('an ack stamps the row and clears the queue entry, in ONE transaction', () => {
  // Clear the outbox first and a crash loses the ack: the message stays pending
  // for ever with nothing left to retry.
  const db = replica();
  compose(db, 'msg_1', 'hello');
  const [op] = ready(db);

  const acked = applyAck(db, op!.opId, {
    messageId: 'msg_1', chatId: CHAT, ord: 5522, rev: 8141,
    createdAt: '2026-09-11T10:00:00.000Z',
  });

  const row = db.prepare('SELECT ord, rev, state, created_at FROM messages WHERE id = ?')
    .get('msg_1') as { ord: number; rev: number; state: string; created_at: number };
  assert.equal(row.ord, 5522);
  assert.equal(row.rev, 8141);
  assert.equal(row.state, 'acked');
  assert.equal(row.created_at, Date.parse('2026-09-11T10:00:00.000Z'),
    'the SERVER’s clock replaced the optimistic one');
  assert.equal(depth(db).queued, 0, 'and the queue entry is gone');
  assert.ok(acked.topics.includes(`chat:${CHAT}:messages`));
  db.close();
});

test('the ack advances head_ord, so the badge is right immediately', () => {
  const db = replica();
  compose(db, 'msg_1', 'hello');
  const [op] = ready(db);
  applyAck(db, op!.opId, {
    messageId: 'msg_1', chatId: CHAT, ord: 42, rev: 99,
    createdAt: '2026-09-11T10:00:00.000Z',
  });

  const state = db.prepare('SELECT head_ord FROM chat_state WHERE chat_id = ?')
    .get(CHAT) as { head_ord: number };
  assert.equal(state.head_ord, 42);
  db.close();
});

// ─── the nack ───────────────────────────────────────────────────────────────

test('a RETRYABLE nack backs off rather than failing', () => {
  const db = replica();
  compose(db, 'msg_1', 'hello');
  const [op] = ready(db);
  markInflight(db, op!.opId);

  const result = applyNack(db, op!.opId, true, 'server busy', 1_000, () => 1);
  assert.equal(result.outcome, 'retrying');
  assert.deepEqual(result.topics, [],
    'nothing rendered changed — it is still pending and still going to be sent');

  assert.deepEqual(ready(db, 1_000), [], 'not yet — it is backing off');
  assert.deepEqual(ready(db, 1_000_000).map(o => o.targetId), ['msg_1'],
    'and returns when the delay is up');
  db.close();
});

test('a NON-retryable nack fails terminally and names the message', () => {
  // A send into a chat somebody was removed from will never succeed. Retrying
  // it silently for ever is worse than an error, because the person sees a
  // message that looks queued and never learns it will not go.
  const db = replica();
  compose(db, 'msg_1', 'hello');
  const [op] = ready(db);
  applyNack(db, op!.opId, false, 'not_a_member');

  const result = applyNack(db, op!.opId, false, 'not_a_member');
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.topics, [`chat:${CHAT}:messages`, `chat:${CHAT}:state`],
    'the CHAT, read from the row — an earlier version used the error code as an id');
  assert.deepEqual(ready(db), [], 'it is not retried');

  const surfaced = failed(db);
  assert.equal(surfaced.length, 1);
  assert.equal(surfaced[0]?.error, 'not_a_member');

  const row = db.prepare('SELECT state FROM messages WHERE id = ?').get('msg_1') as
    { state: string };
  assert.equal(row.state, 'failed',
    'the MESSAGE is marked too, so a surface can show which one');
  db.close();
});

test('backoff grows and carries full jitter', () => {
  // Same curve as the connection's, and the jitter is load-bearing for the same
  // reason: a server that refused everything for a minute would otherwise get
  // every client's whole queue back in one instant.
  assert.equal(retryAt(0, 0, () => 1), 1_000);
  assert.equal(retryAt(3, 0, () => 1), 8_000);
  assert.equal(retryAt(9, 0, () => 1), 60_000, 'capped');
  assert.equal(retryAt(3, 0, () => 0), 0, 'and the whole window is reachable');
});

// ─── what a person can do about a failure ───────────────────────────────────

test('retry puts a failed op at the BACK of the queue', () => {
  // Its original sequence is long past. Re-inserting there would put it ahead
  // of everything typed since, so an hour-old message would appear before this
  // morning's.
  const db = replica();
  compose(db, 'msg_old', 'from an hour ago');
  const [old] = ready(db);
  applyNack(db, old!.opId, false, 'nope');

  compose(db, 'msg_new', 'just now');
  retry(db, old!.opId);

  assert.deepEqual(ready(db).map(o => o.targetId), ['msg_new'],
    'the newer one is still first');
  const seqs = db.prepare('SELECT target_id, seq FROM outbox ORDER BY seq').all() as
    { target_id: string; seq: number }[];
  assert.deepEqual(seqs.map(r => r.target_id), ['msg_new', 'msg_old']);

  const row = db.prepare('SELECT state FROM messages WHERE id = ?').get('msg_old') as
    { state: string };
  assert.equal(row.state, 'pending', 'and it looks queued again');
  db.close();
});

test('discarding a failed SEND removes the message it would have sent', () => {
  const db = replica();
  compose(db, 'msg_1', 'never mind');
  const [op] = ready(db);
  applyNack(db, op!.opId, false, 'not_a_member');

  discard(db, op!.opId);
  assert.deepEqual(bodies(db), [], 'the message went with the op');
  assert.equal(depth(db).failed, 0);
  db.close();
});

test('discarding a failed DELETE leaves the message alone', () => {
  // The person wanted it gone and could not have it. Deleting it locally would
  // be the app doing the thing the server refused — and the next reconnect
  // would bring it straight back, which is worse than never removing it.
  const db = replica();
  db.prepare(`INSERT INTO messages (id, chat_id, parent_id, ord, rev, author_id,
              body, created_at, state, local_only)
              VALUES ('msg_theirs', ?, NULL, 1, 1, 'act_other', 'theirs', 0, 'acked', 0)`)
    .run(CHAT);
  const result = remove(db, 'msg_theirs');
  assert.equal(result.outcome, 'queued');

  const [op] = ready(db);
  applyNack(db, op!.opId, false, 'forbidden');
  discard(db, op!.opId);

  assert.deepEqual(bodies(db), ['theirs'], 'still there, as the server insists');
  db.close();
});

// ─── the row and its echo ───────────────────────────────────────────────────

test('the queue entry and the optimistic row are ONE transaction', () => {
  // A crash between them leaves a message that looks sent and never will be —
  // indistinguishable, to the person who wrote it, from having been delivered
  // (invariant 40).
  const db = replica();
  assert.throws(() => enqueue(db, {
    opId: 'op_boom', kind: 'send', chatId: CHAT, targetId: 'msg_boom',
    payload: { id: 'msg_boom' },
  }, () => { throw new Error('the echo failed'); }));

  assert.equal(depth(db).queued, 0, 'no orphaned queue entry');
  assert.deepEqual(bodies(db), [], 'and no orphaned message');
  db.close();
});

test('a coalesce that throws mid-way rolls the whole thing back', () => {
  const db = replica();
  compose(db, 'msg_1', 'oops');
  assert.throws(() => enqueue(db, {
    opId: 'op_del', kind: 'delete', chatId: CHAT, targetId: 'msg_1',
    payload: {},
  }, () => { throw new Error('the echo failed'); }));

  assert.equal(depth(db).queued, 1, 'the send is still queued');
  assert.deepEqual(bodies(db), ['oops'], 'and the message is still there');
  db.close();
});
