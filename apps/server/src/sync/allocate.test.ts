// Allocation and idempotency (allocate.ts) — step 2 of the sync build plan
// (docs/SYNC-FLOWS.md §2), lettered step B by PHASE-2-SYNC.md §3.
//
// The two failures guarded here are both silent, so both are asserted against a
// real engine with real concurrency rather than reasoned about:
//
//   a lost update  → two messages share an ordinal, and every client that saw
//                    the first has a corrupt read cursor
//   a missing ack  → one lost connection becomes two messages, which looks
//                    exactly like a user sending twice
//
// Each has a NEGATIVE CONTROL that performs the unsafe version and asserts it
// really does break. Without those, "we used the atomic form" is a claim about
// a diff, and the test that checks it would pass just as happily against code
// that never had a race to lose.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import {
  allocateChat, applyOnce, UnknownChatError, OpOwnershipError,
} from './allocate.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const actor = ulid('act');
const other = ulid('act');

before(async () => {
  if (!up) return;
  await db.insertInto('organizations')
    .values({ id: org, workos_org_id: `test_${org}`, name: 'Allocate' }).execute();
  await db.insertInto('workspaces')
    .values({ id: wsp, org_id: org, name: 'Allocate', slug: `t-${wsp.slice(-6).toLowerCase()}` })
    .execute();
  for (const id of [actor, other]) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type: 'human',
      handle: `t-${id.slice(-6).toLowerCase()}`, display_name: 'Allocate Test',
      avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${id}`,
      owner_actor_id: null, provisioned_by: 'api', state: 'active',
    }).execute();
  }
});

after(async () => {
  if (!up) return;
  // Spaces first: it cascades to chats, messages and ops. Deleting the org in
  // one statement would hit messages' RESTRICT on author_id.
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

/** A fresh channel with its sole chat. Counters start at zero. */
async function freshChat(): Promise<string> {
  const space = ulid('spc');
  const chat = ulid('cht');
  await db.insertInto('spaces').values({
    id: space, org_id: org, workspace_id: wsp, kind: 'channel', name: 'general',
    slug: null, topic: null, visibility: 'public', membership_policy: 'open',
    created_by_actor_id: actor } as never).execute();
  await db.insertInto('chats').values({
    id: chat, workspace_id: wsp, space_id: space, kind: 'sole', name: null,
    created_by_actor_id: actor } as never).execute();
  return chat;
}

const counters = async (chat: string) =>
  db.selectFrom('chats').select(['next_ord', 'next_rev'])
    .where('id', '=', chat).executeTakeFirstOrThrow();

// ── allocation ─────────────────────────────────────────────────────────────

test('the first message takes ordinal 1 and revision 1', opts, async () => {
  const chat = await freshChat();
  const first = await db.transaction().execute(trx => allocateChat(trx, chat, true));
  // The stream and the workspace ride along, from this same statement rather
  // than a second read: they are what an event is filed under, and reading them
  // separately is one more pair of values that can disagree (`events.ts`).
  assert.deepEqual(first, {
    ord: 1, rev: 1, stream: { kind: 'chat', id: chat }, workspaceId: wsp,
  });
});

test('a mutation takes a revision and NO ordinal', opts, async () => {
  // The two-counter model, in the smallest possible assertion. A delete must
  // not consume an ordinal — display order, read cursors and retention all key
  // on `ord`, and a delete changes none of them.
  const chat = await freshChat();
  await db.transaction().execute(trx => allocateChat(trx, chat, true));
  const mutation = await db.transaction().execute(trx => allocateChat(trx, chat, false));

  assert.equal(mutation.ord, null, 'a mutation reports no ordinal at all');
  assert.equal(mutation.rev, 2);
  const after = await counters(chat);
  assert.equal(after.next_ord, 1, 'the ordinal counter did not move');
  assert.equal(after.next_rev, 2);
});

test('interleaved sends and deletes diverge the two counters', opts, async () => {
  // send, delete, send, delete, send. This is what the whole two-counter model
  // exists for, and what nothing in this phase would exercise if delete had
  // stayed in Phase 4 (PHASE-2-SYNC.md §1).
  const chat = await freshChat();
  const allocations = [];
  for (const isMessage of [true, false, true, false, true]) {
    allocations.push(await db.transaction().execute(trx => allocateChat(trx, chat, isMessage)));
  }
  assert.deepEqual(allocations.map(a => a.ord), [1, null, 2, null, 3]);
  assert.deepEqual(allocations.map(a => a.rev), [1, 2, 3, 4, 5]);
  assert.deepEqual({ ...(await counters(chat)) }, { next_ord: 3, next_rev: 5 });
});

test('ordinals and revisions are numbers, not strings', opts, async () => {
  // The int8 parser (db/types.ts) is what makes this true, and `rev + 1` being
  // "51" rather than 51 would be invisible everywhere except in the ordering it
  // silently destroys.
  const chat = await freshChat();
  const { ord, rev } = await db.transaction().execute(trx => allocateChat(trx, chat, true));
  assert.equal(typeof ord, 'number');
  assert.equal(typeof rev, 'number');
});

test('allocating in a chat that does not exist throws, and writes nothing', opts, async () => {
  // Returning undefined here would let `ord: undefined` reach an INSERT.
  await assert.rejects(
    () => db.transaction().execute(trx => allocateChat(trx, 'cht_nonexistent', true)),
    (err: Error) => {
      assert.ok(err instanceof UnknownChatError);
      return true;
    });
});

// ── concurrency: the lost update ───────────────────────────────────────────

/** Two independent connections, so a lock between them is a real lock. */
async function twoClients() {
  const first = await pool.connect();
  const second = await pool.connect();
  return { first, second, release: () => { first.release(); second.release(); } };
}

const bump = 'UPDATE chats SET next_ord = next_ord + 1 WHERE id = $1 RETURNING next_ord';
const settles = (promise: Promise<unknown>) => Promise.race([
  promise.then(() => 'settled' as const),
  new Promise<'blocked'>(resolve => { setTimeout(() => resolve('blocked'), 250); }),
]);

test('a second allocator BLOCKS on the row lock, then allocates the next ordinal',
  opts, async () => {
  // Deterministic rather than a race of N parallel calls: the point is not that
  // duplicates are unlikely, it is that they are impossible, and a probabilistic
  // test cannot say that.
  const chat = await freshChat();
  const { first, second, release } = await twoClients();
  try {
    await first.query('BEGIN');
    await second.query('BEGIN');

    const firstOrd = (await first.query(bump, [chat])).rows[0].next_ord;
    assert.equal(firstOrd, 1);

    // Issued but NOT awaited: it is waiting on the row lock the first holds.
    const pending = second.query(bump, [chat]);
    assert.equal(await settles(pending), 'blocked',
      'the second allocator proceeded without waiting — there is no lock');

    await first.query('COMMIT');
    const secondOrd = (await pending).rows[0].next_ord;
    await second.query('COMMIT');

    assert.equal(secondOrd, 2, 'the second re-read the committed value and added to it');
  } finally { release(); }
});

test('NEGATIVE CONTROL: read-then-write really does lose an ordinal', opts, async () => {
  // The unsafe form, performed. Two transactions read the same counter and both
  // write the same successor, so two messages would be handed ordinal 1.
  //
  // Without this the test above proves only that the safe form works — not that
  // the danger it guards against exists, nor that these tests could detect it.
  const chat = await freshChat();
  const { first, second, release } = await twoClients();
  try {
    await first.query('BEGIN');
    await second.query('BEGIN');

    const read = 'SELECT next_ord FROM chats WHERE id = $1';
    const firstRead = (await first.query(read, [chat])).rows[0].next_ord;
    const secondRead = (await second.query(read, [chat])).rows[0].next_ord;
    assert.equal(firstRead, 0);
    assert.equal(secondRead, 0, 'neither read blocks — a plain SELECT takes no lock');

    const write = 'UPDATE chats SET next_ord = $2 WHERE id = $1';
    await first.query(write, [chat, firstRead + 1]);
    await first.query('COMMIT');
    await second.query(write, [chat, secondRead + 1]);
    await second.query('COMMIT');

    const { next_ord } = await counters(chat);
    assert.equal(next_ord, 1,
      'two allocations, one ordinal — the exact corruption the atomic form prevents');
  } finally { release(); }
});

test('many concurrent allocations produce no duplicates and no holes', opts, async () => {
  // The realistic shape on top of the deterministic proof: 25 senders at once
  // through a 10-connection pool. Asserted as a SET rather than a sequence,
  // because the order they finish in is genuinely unspecified — only their
  // uniqueness and their coverage are guaranteed.
  const chat = await freshChat();
  const results = await Promise.all(Array.from({ length: 25 }, () =>
    db.transaction().execute(trx => allocateChat(trx, chat, true))));

  const ords = results.map(r => r.ord).sort((a, b) => (a ?? 0) - (b ?? 0));
  assert.deepEqual(ords, Array.from({ length: 25 }, (_, i) => i + 1));
  const revs = new Set(results.map(r => r.rev));
  assert.equal(revs.size, 25, 'every revision is distinct too');
});

// ── idempotency ────────────────────────────────────────────────────────────

const claimFor = (chat: string, opId: string, actorId = actor) =>
  ({ opId, actorId, chatId: chat, kind: 'send' as const });

/** Inserts a message with the allocated ordinal, and reports how often it ran. */
function sendWork(chat: string, messageId: string, ran: { count: number }) {
  return async (trx: Parameters<Parameters<typeof applyOnce>[2]>[0]) => {
    ran.count += 1;
    const { ord, rev } = await allocateChat(trx, chat, true);
    await trx.insertInto('messages').values({
      id: messageId, chat_id: chat, parent_id: null, ord: ord as number, rev,
      author_id: actor, body: 'hello' } as never).execute();
    return { id: messageId, ord, rev };
  };
}

test('a replayed op returns the SAME ack and does the work once', opts, async () => {
  const chat = await freshChat();
  const opId = ulid('op');
  const messageId = ulid('msg');
  const ran = { count: 0 };

  const first = await applyOnce(db, claimFor(chat, opId), sendWork(chat, messageId, ran));
  const second = await applyOnce(db, claimFor(chat, opId), sendWork(chat, messageId, ran));

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.result, first.result, 'the same ordinal, not a new one');
  assert.equal(ran.count, 1, 'the second attempt never ran the work');

  const rows = await db.selectFrom('messages').select('id').where('chat_id', '=', chat).execute();
  assert.equal(rows.length, 1, 'one message, from two sends of the same op');
  // And no ordinal was consumed by the replay.
  assert.equal((await counters(chat)).next_ord, 1);
});

test('NEGATIVE CONTROL: without the ledger, the same op sends twice', opts, async () => {
  // What applyOnce prevents, performed. Two identical ops that skip the ledger
  // produce two messages with two ordinals — and a user seeing their message
  // twice cannot tell that from having pressed send twice, which is why this
  // class of bug survives so long in the wild.
  const chat = await freshChat();
  const ran = { count: 0 };
  await db.transaction().execute(sendWork(chat, ulid('msg'), ran));
  await db.transaction().execute(sendWork(chat, ulid('msg'), ran));

  const rows = await db.selectFrom('messages').select('ord').where('chat_id', '=', chat).execute();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => Number(r.ord)).sort(), [1, 2]);
});

test('two CONCURRENT copies of one op still produce one message', opts, async () => {
  // The case the retry exists for, and the one that actually happens: a client
  // resends because the ack was lost, and the resend races the original.
  //
  // Both transactions pass the ledger read, both do the work, and the loser
  // collides on `messages_pkey` — NOT on the ledger, which is why the retry
  // cannot be scoped to the ledger's own constraint.
  const chat = await freshChat();
  const opId = ulid('op');
  const messageId = ulid('msg');
  const ran = { count: 0 };

  const [first, second] = await Promise.all([
    applyOnce(db, claimFor(chat, opId), sendWork(chat, messageId, ran)),
    applyOnce(db, claimFor(chat, opId), sendWork(chat, messageId, ran)),
  ]);

  assert.deepEqual(first.result, second.result, 'both callers got the same ack');
  assert.equal([first.replayed, second.replayed].filter(Boolean).length, 1,
    'exactly one of the two was answered from the ledger');

  const rows = await db.selectFrom('messages').select('id').where('chat_id', '=', chat).execute();
  assert.equal(rows.length, 1);
  assert.equal((await counters(chat)).next_ord, 1, 'the loser burned no ordinal');
});

test('an op_id presented by a different actor is refused', opts, async () => {
  // op_id is chosen by a client. Handing back the original ack would name a
  // message the second actor may have no right to see.
  const chat = await freshChat();
  const opId = ulid('op');
  const ran = { count: 0 };
  await applyOnce(db, claimFor(chat, opId), sendWork(chat, ulid('msg'), ran));

  await assert.rejects(
    () => applyOnce(db, claimFor(chat, opId, other), sendWork(chat, ulid('msg'), ran)),
    (err: Error) => {
      assert.ok(err instanceof OpOwnershipError);
      return true;
    });
  assert.equal(ran.count, 1, 'the refused caller never reached the work');
});

test('work that fails burns NO ordinal — the allocation rolls back with it', opts, async () => {
  // The reason allocate() takes a Transaction rather than a Kysely. A burned
  // ordinal is permanent: head_ord would name a message that does not exist,
  // and every client's unread arithmetic stays one too high for ever.
  const chat = await freshChat();
  await assert.rejects(() => applyOnce(db, claimFor(chat, ulid('op')), async (trx) => {
    await allocateChat(trx, chat, true);
    throw new Error('the write failed after allocating');
  }), /the write failed after allocating/);

  assert.deepEqual({ ...(await counters(chat)) }, { next_ord: 0, next_rev: 0 });
  const ledger = await db.selectFrom('ops').select('op_id').where('chat_id', '=', chat).execute();
  assert.deepEqual(ledger, [], 'and no ledger entry claims it succeeded');
});

test('the RETRY path, deterministically: a conflict then a replay', opts, async () => {
  // The concurrent test above proves the outcome but not the route — whether
  // the loser actually retried, or whether the two transactions happened to
  // serialise so its first ledger read already saw the winner. Timing decides
  // that, so it cannot be asserted there without being flaky.
  //
  // Here the race is staged. On its first invocation the work commits the
  // winner's rows from a SEPARATE connection — which is exactly what a winning
  // transaction committing mid-flight looks like — and then collides with them.
  const chat = await freshChat();
  const opId = ulid('op');
  const messageId = ulid('msg');
  let attempts = 0;

  const result = await applyOnce(db, claimFor(chat, opId), async (trx) => {
    attempts += 1;
    if (attempts === 1) {
      const winner = { id: messageId, ord: 1, rev: 1 };
      await db.insertInto('messages').values({
        id: messageId, chat_id: chat, parent_id: null, ord: 1, rev: 1,
        author_id: actor, body: 'winner' } as never).execute();
      await db.insertInto('ops').values({
        op_id: opId, actor_id: actor, chat_id: chat, kind: 'send',
        result: JSON.stringify(winner) } as never).execute();
    }
    const { ord, rev } = await allocateChat(trx, chat, true);
    // Collides with the winner's row on the first attempt.
    await trx.insertInto('messages').values({
      id: messageId, chat_id: chat, parent_id: null, ord: ord as number, rev,
      author_id: actor, body: 'loser' } as never).execute();
    return { id: messageId, ord, rev };
  });

  assert.equal(attempts, 1, 'the work ran once and was never re-run');
  assert.equal(result.replayed, true, 'the retry was answered from the ledger');
  assert.deepEqual(result.result, { id: messageId, ord: 1, rev: 1 },
    'and it returned the WINNER ack, not a recomputed one');

  const bodies = await db.selectFrom('messages').select('body')
    .where('chat_id', '=', chat).execute();
  assert.deepEqual(bodies.map(r => r.body), ['winner'], 'the loser wrote nothing');
  // Zero, not one: the staged winner was inserted directly rather than through
  // allocate(), so it never bumped the counter — and the loser's allocation
  // rolled back with its transaction. Which is the claim that matters here.
  assert.equal((await counters(chat)).next_ord, 0, 'the loser burned no ordinal');
});

test('a unique violation that is NOT a replay surfaces instead of retrying for ever',
  opts, async () => {
  // Two DIFFERENT ops claiming one message id is a client bug, not a resend.
  // The retry re-reads the ledger, finds nothing, runs the work again, fails
  // the same way — and throws. Absorbing it would hide a broken client and
  // leave one of the two messages silently missing.
  const chat = await freshChat();
  const messageId = ulid('msg');
  const ran = { count: 0 };
  await applyOnce(db, claimFor(chat, ulid('op')), sendWork(chat, messageId, ran));

  await assert.rejects(
    () => applyOnce(db, claimFor(chat, ulid('op')), sendWork(chat, messageId, ran)),
    (err: Error) => {
      assert.equal((err as { code?: string }).code, '23505');
      return true;
    });
  assert.equal(ran.count, 3, 'the work ran once, then twice more across the retry');
});
