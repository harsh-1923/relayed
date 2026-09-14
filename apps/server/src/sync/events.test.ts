// The event log, against Postgres — step 4 of the sync build plan
// (docs/SYNC-FLOWS.md §2).
//
// What is being asserted here is one claim in three forms: the log records what
// HAPPENED, where the domain tables can only record what is TRUE NOW. Every
// test below fails, or is impossible to write at all, against the row-derived
// catch-up this replaced.
//
// The sharpest of them is "a non-message change has a catch-up path". That one
// is not a regression test — before this step there was no code path whatsoever
// by which a client learned that a space had gained a member while it was away,
// because nothing about a membership lives in `messages`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import {
  createChannel, joinSpace, addToSpace, leaveSpace, removeFromSpace,
} from './spaces.ts';
import { send, deleteMessage, markRead } from './ops.ts';
import { eventsSince, catchup } from './feed.ts';
import { allocateStream } from './allocate.ts';
import {
  appendEvent, chatStream, spaceStream, workspaceStream, streamName,
  type MessageCreated,
} from './events.ts';
import { recordActor } from './directory.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const me = ulid('act');
const bob = ulid('act');

before(async () => {
  if (!up) return;
  await db.insertInto('organizations')
    .values({ id: org, workos_org_id: `test_${org}`, name: 'Events' }).execute();
  await db.insertInto('workspaces')
    .values({ id: wsp, org_id: org, name: 'Events', slug: `e-${wsp.slice(-6).toLowerCase()}` })
    .execute();
  for (const id of [me, bob]) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type: 'human',
      handle: `e-${id.slice(-6).toLowerCase()}`, display_name: 'Event Test',
      avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${id}`,
      owner_actor_id: null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({
      scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member',
    }).execute();
  }
});

after(async () => {
  if (!up) return;
  // Events first: `sync_events` cascades from `workspaces`, not from `spaces`,
  // so a space delete leaves its stream's rows behind.
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

/** A channel with `me` as admin. Three space events by construction. */
async function channel() {
  return createChannel(db, { workspaceId: wsp, name: `c-${ulid('x')}`, createdBy: me });
}

/** Every event on a stream, as `[rev, type]` pairs — the shape assertions read. */
async function log(stream: Parameters<typeof eventsSince>[2]): Promise<[number, string][]> {
  const events = await eventsSince(db, me, stream, 0);
  return events.map(event => [event.rev, event.type]);
}

// ── the claim: a row cannot record its own history ──────────────────────────

test('three mutations of ONE message are three recoverable events', opts, async () => {
  // The failure this prevents, written out because it is the whole argument.
  // Derive catch-up from `messages` and this chat's rows afterwards hold m1 at
  // rev 3, deleted, with an empty body. A client catching up from zero learns
  // ONE event and hears of m1 only as the deletion of something it never saw
  // created — revisions 1 and 2 are recoverable from nowhere at all.
  //
  // The middle event is a `message.edited`, which no op writes yet: edits are
  // Phase 4. It is inserted directly because the property under test belongs to
  // the READ path, and writing it now means Phase 4 does not have to rediscover
  // that the read path was the part that had to change (docs/SYNC-FLOWS.md §12.1).
  const { chatId } = await channel();
  const messageId = ulid('msg');
  const stream = chatStream(chatId);

  for (const [rev, type] of [[1, 'message.created'], [2, 'message.edited'],
                             [3, 'message.deleted']] as const) {
    await db.insertInto('sync_events').values({
      event_id: ulid('evt'), workspace_id: wsp,
      stream_kind: 'chat', stream_id: chatId, stream_rev: rev, event_type: type,
      payload: sql`${JSON.stringify({ id: messageId })}::jsonb`,
    }).execute();
  }

  assert.deepEqual(await log(stream),
    [[1, 'message.created'], [2, 'message.edited'], [3, 'message.deleted']],
    'every mutation is its own row, so none overwrites the evidence of another');

  // And through `catchup`, which is what a client actually calls. `eventsSince`
  // is the read; `catchup` wraps it with the gap-versus-replay policy, and a
  // replay that quietly dropped an event would be invisible to the assertion
  // above.
  const replay = await catchup(db, me, chatStream(chatId), 0);
  assert.equal(replay.kind, 'replay');
  if (replay.kind !== 'replay') return;
  assert.deepEqual(replay.events.map(event => event.type),
    ['message.created', 'message.edited', 'message.deleted']);
  assert.equal(replay.toRev, 3, 'the frontier this batch would leave behind');
});

test('a truncated replay reports the frontier it DELIVERED, not the head',
  opts, async () => {
    // Found by the assertion above failing, and it is a real latent bug rather
    // than a test artifact. `toRev` used to be the chat's head. That is the same
    // number as the last delivered event only because the replay threshold and
    // `eventsSince`'s limit are, today, the same constant — and step 9 of the
    // plan exists partly to retune the first against real traffic.
    //
    // Raise the threshold without raising the limit and the old code told a
    // client its frontier had reached rev 600 while sending it 500 events. The
    // client would advance past a hundred changes it never received: a silent
    // permanent hole, which is precisely what the contiguity rule forbids
    // (invariant 1). Nothing would have looked wrong.
    const { chatId } = await channel();
    await sql`
      INSERT INTO sync_events
        (event_id, workspace_id, stream_kind, stream_id, stream_rev, event_type, payload)
      SELECT 'evt_trunc_' || ${chatId} || '_' || n, ${wsp}, 'chat', ${chatId}, n,
             'message.created', '{"id":"m"}'::jsonb
        FROM generate_series(1, 600) n
    `.execute(db);
    await db.updateTable('chats').set({ next_rev: 600 })
      .where('id', '=', chatId).execute();

    // Threshold above the distance, so this is a replay rather than a gap —
    // while the read's own limit still caps the batch at 500.
    const replay = await catchup(db, me, chatStream(chatId), 0, 1000);
    assert.equal(replay.kind, 'replay');
    if (replay.kind !== 'replay') return;

    assert.equal(replay.events.length, 500, 'the batch is capped by the read limit');
    assert.equal(replay.toRev, 500,
      'the frontier this batch earns — NOT the head at 600');
    assert.equal(replay.events.at(-1)?.rev, replay.toRev,
      'and it is exactly the last event delivered');
  });

test('space and workspace revisions are numbers, not strings', opts, async () => {
  // node-postgres returns int8 as a STRING by design, because int8 outruns a
  // JavaScript number. Two more bigint columns landed with this step, and the
  // parser in db/types.ts is registered per TYPE rather than per column — so it
  // covers them. Asserted rather than assumed, because the failure is silent:
  // `next_rev + 1` would evaluate to "4" with the compiler satisfied and every
  // happy-path test green.
  const { spaceId } = await channel();
  const space = await db.transaction()
    .execute(trx => allocateStream(trx, spaceStream(spaceId)));
  const workspace = await db.transaction()
    .execute(trx => allocateStream(trx, workspaceStream(wsp)));

  assert.equal(typeof space.rev, 'number');
  assert.equal(typeof workspace.rev, 'number');
  // Creating the channel wrote three space events, so this allocation is the
  // fourth. A string would make the next line 41 rather than 5, which is the
  // whole failure mode in one character.
  assert.equal(space.rev, 4);
  assert.equal(space.rev + 1, 5, 'arithmetic, not concatenation');
  assert.ok(Number.isSafeInteger(space.rev) && Number.isSafeInteger(workspace.rev));
});

test('an unknown event type reads back intact rather than being dropped', opts, async () => {
  // The read side types `type` as a plain string, deliberately. A server that
  // narrowed it to the types it currently writes would drop a row written by a
  // newer deployment during a rolling restart — and clients are required to
  // tolerate exactly this (an unknown event type still advances the cursor,
  // invariant 32), so the server may not be stricter than they are.
  const { chatId } = await channel();
  await db.insertInto('sync_events').values({
    event_id: ulid('evt'), workspace_id: wsp, stream_kind: 'chat',
    stream_id: chatId, stream_rev: 1, event_type: 'message.pinned',
    payload: sql`${JSON.stringify({ id: 'msg_x' })}::jsonb`,
  }).execute();

  assert.deepEqual(await log(chatStream(chatId)), [[1, 'message.pinned']]);
});

// ── the ops write their events ─────────────────────────────────────────────

test('send and delete each append exactly one event, in the same transaction',
  opts, async () => {
    const { chatId } = await channel();
    const first = ulid('msg');
    await send(db, { opId: ulid('op'), chatId, actorId: me, messageId: first, body: 'one' });
    await send(db, { opId: ulid('op'), chatId, actorId: me,
                     messageId: ulid('msg'), body: 'two' });
    await deleteMessage(db, { opId: ulid('op'), chatId, actorId: me, messageId: first });

    assert.deepEqual(await log(chatStream(chatId)),
      [[1, 'message.created'], [2, 'message.created'], [3, 'message.deleted']],
      'one event per op — counted, not read off the implementation');
  });

test('the event carries the same created_at the sender was acked with', opts, async () => {
  // If these disagreed, one message would render at two different times
  // depending on whether you were the author: the sender applies the ack, and
  // every other device applies the event.
  const { chatId } = await channel();
  const messageId = ulid('msg');
  const { ack } = await send(db, {
    opId: ulid('op'), chatId, actorId: me, messageId, body: 'timestamped',
  });

  const [event] = await eventsSince(db, me, chatStream(chatId), 0);
  const payload = event?.payload as MessageCreated;
  assert.equal(payload.created_at, ack.createdAt);
  assert.equal(payload.ord, ack.ord);
  assert.equal(payload.author_id, me);
});

test('a replayed op appends NO second event', opts, async () => {
  // The idempotency ledger short-circuits before `work` runs, so the append
  // never happens twice. Worth asserting rather than assuming: an event
  // appended outside `applyOnce` would deliver a duplicate message to every
  // OTHER device while the sender's own ack correctly reported one.
  const { chatId } = await channel();
  const opId = ulid('op');
  const messageId = ulid('msg');
  const input = { opId, chatId, actorId: me, messageId, body: 'once' };
  const first = await send(db, input);
  const replay = await send(db, input);

  assert.deepEqual(replay.ack, first.ack, 'the stored ack, verbatim');
  // The replay carries no EVENT, which is a second guarantee on top of the
  // ack's. The ledger stops the work happening twice; this stops the caller
  // fanning out a message every other device already has.
  assert.ok(first.event, 'the first attempt did the work');
  assert.equal(replay.event, undefined);
  assert.equal((await log(chatStream(chatId))).length, 1);
});

test('markRead appends nothing — read state is not part of the log', opts, async () => {
  // A max-register converges without ordering and replaying it is already a
  // no-op, so a revision would buy nothing and would make the busiest action in
  // the product the busiest stream in the workspace.
  const { chatId } = await channel();
  await send(db, { opId: ulid('op'), chatId, actorId: me,
                   messageId: ulid('msg'), body: 'read me' });
  const before = await log(chatStream(chatId));
  await markRead(db, me, chatId, 1);
  assert.deepEqual(await log(chatStream(chatId)), before);
});

// ── the part that had no catch-up path at all before ────────────────────────

test('creating a channel is three events on the SPACE stream', opts, async () => {
  // Three rather than one composite, because `chat.created` and
  // `space.member_added` have to exist for rooms and for joins anyway — so a
  // client that handles them handles creation with no extra code.
  const { spaceId, chatId } = await channel();
  assert.deepEqual(await log(spaceStream(spaceId)),
    [[1, 'space.created'], [2, 'chat.created'], [3, 'space.member_added']]);

  const events = await eventsSince(db, me, spaceStream(spaceId), 0);
  assert.equal((events[1]?.payload as { id: string }).id, chatId);
  assert.equal((events[2]?.payload as { actor_id: string }).actor_id, me,
    'the founder joins as an ordinary member event, not a special case');
});

test('membership changes are recoverable by catch-up', opts, async () => {
  // NOT a regression test. Before the log there was no path by which a client
  // learned this had happened while it was away: a membership is not in
  // `messages`, so `WHERE rev > ?` over message rows could never return it.
  const { spaceId } = await channel();
  await addToSpace(db, spaceId, bob, me);
  await removeFromSpace(db, spaceId, bob, me);
  await joinSpace(db, spaceId, bob);
  await leaveSpace(db, spaceId, bob);

  assert.deepEqual((await log(spaceStream(spaceId))).slice(3), [
    [4, 'space.member_added'], [5, 'space.member_removed'],
    [6, 'space.member_added'], [7, 'space.member_removed'],
  ]);
});

test('catch-up from a mid-stream cursor returns only what came after',
  opts, async () => {
    const { spaceId } = await channel();
    await addToSpace(db, spaceId, bob, me);
    const events = await eventsSince(db, me, spaceStream(spaceId), 2);
    assert.deepEqual(events.map(event => event.rev), [3, 4],
      'strictly greater than the cursor — a client already holds its own rev');
  });

test('an actor joining a workspace is one event on the workspace stream',
  opts, async () => {
    // One row on every client, rather than a re-send of the directory. That
    // difference is why the directory is a stream (DESIGN.md §9.9).
    const newcomer = ulid('act');
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('actors').values({
        id: newcomer, org_id: org, workspace_id: wsp, type: 'human',
        handle: `n-${newcomer.slice(-6).toLowerCase()}`, display_name: 'Newcomer',
        avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${newcomer}`,
        owner_actor_id: null, provisioned_by: 'api', state: 'active',
      }).execute();
      await recordActor(trx, 'actor.created', {
        id: newcomer, workspaceId: wsp, type: 'human',
        handle: 'newcomer', displayName: 'Newcomer', avatarUrl: null, state: 'active',
      });
    });

    const events = await eventsSince(db, me, workspaceStream(wsp), 0);
    const arrival = events.find(event =>
      (event.payload as { id: string }).id === newcomer);
    assert.ok(arrival, 'the directory stream carries the new member');
    assert.equal(arrival.type, 'actor.created');
    assert.equal((arrival.payload as { display_name: string }).display_name, 'Newcomer');
  });

// ── allocation on a stream that has no ordinal ─────────────────────────────

test('two concurrent allocators on ONE space never receive the same rev',
  opts, async () => {
    // The same proof `allocate.test.ts` makes for chats, re-run on the
    // generalised signature — because "spaces are low-traffic" is exactly the
    // reasoning that would justify a read-then-write counter here, and a lost
    // update on a rev silently REUSES a position in every client's cursor.
    const { spaceId } = await channel();
    const stream = spaceStream(spaceId);
    const allocations = await Promise.all(Array.from({ length: 8 }, () =>
      db.transaction().execute(trx => allocateStream(trx, stream))));

    const revs = allocations.map(allocation => allocation.rev).sort((a, b) => a - b);
    assert.deepEqual(revs, [4, 5, 6, 7, 8, 9, 10, 11],
      'eight distinct, contiguous revisions after the three from creation');
    assert.equal(new Set(revs).size, 8);
  });

test('an allocation reports the workspace it belongs to', opts, async () => {
  // From the SAME statement that takes the revision. A second read could see a
  // different answer, and an event filed under the wrong tenant is one that
  // fanout delivers to the wrong sockets.
  const { spaceId } = await channel();
  const allocated = await db.transaction()
    .execute(trx => allocateStream(trx, spaceStream(spaceId)));
  assert.equal(allocated.workspaceId, wsp);
  assert.equal(allocated.stream.kind, 'space');
});

test('allocating on a stream that does not exist throws rather than returning',
  opts, async () => {
    await assert.rejects(
      () => db.transaction().execute(trx =>
        allocateStream(trx, spaceStream('spc_nonexistent'))),
      /no stream space:spc_nonexistent/);
  });

// ── the event and its effect are one transaction ───────────────────────────

test('a rolled back transaction leaves neither the effect nor the event',
  opts, async () => {
    // The rule the log rests on. An append that commits separately from its
    // effect is a change every client applies and the database does not have —
    // and unlike a lost ordinal, nothing about it looks wrong afterwards.
    const { spaceId } = await channel();
    const before = await log(spaceStream(spaceId));

    await assert.rejects(() => db.transaction().execute(async (trx) => {
      const allocated = await allocateStream(trx, spaceStream(spaceId));
      await appendEvent(trx, allocated, 'space.member_added',
        { actor_id: bob, role: 'member' }, { kind: 'stream' });
      throw new Error('the effect failed after the event was written');
    }));

    assert.deepEqual(await log(spaceStream(spaceId)), before,
      'the event rolled back with the transaction that wrote it');
  });

// ── constraints, one test each, against the real engine ────────────────────

test('CONSTRAINT: revision 0 is rejected — a cursor starts there', opts, async () => {
  const { chatId } = await channel();
  await assert.rejects(() => db.insertInto('sync_events').values({
    event_id: ulid('evt'), workspace_id: wsp, stream_kind: 'chat',
    stream_id: chatId, stream_rev: 0, event_type: 'message.created',
    payload: sql`'{}'::jsonb`,
  }).execute(), /sync_event_rev/);
});

test('CONSTRAINT: an unknown stream kind is rejected', opts, async () => {
  // `actor` is the one that would be reached for by mistake, because it is a
  // real stream in the design — just not an ORDERED one. It is a delivery
  // address, and this constraint is what says so at the storage layer.
  await assert.rejects(() => db.insertInto('sync_events').values({
    event_id: ulid('evt'), workspace_id: wsp,
    stream_kind: 'actor' as 'chat', stream_id: me, stream_rev: 1,
    event_type: 'read_state.changed', payload: sql`'{}'::jsonb`,
  }).execute(), /sync_event_kind/);
});

test('CONSTRAINT: one event per revision per stream', opts, async () => {
  // What makes a client cursor meaningful: rev N names exactly one change.
  const { chatId } = await channel();
  const row = {
    workspace_id: wsp, stream_kind: 'chat' as const, stream_id: chatId,
    stream_rev: 1, event_type: 'message.created',
    payload: sql`'{}'::jsonb`,
  };
  await db.insertInto('sync_events').values({ ...row, event_id: ulid('evt') }).execute();
  await assert.rejects(
    () => db.insertInto('sync_events').values({ ...row, event_id: ulid('evt') }).execute(),
    /sync_event_stream/);
});

test('CONSTRAINT: the same revision on two streams is fine', opts, async () => {
  // Revisions are per stream, not global. A workspace-wide sequence would force
  // unrelated features into one order and punch permanent holes for every actor
  // not entitled to most of it (docs/SYNC-FLOWS.md §5).
  const one = await channel();
  const two = await channel();
  for (const { chatId } of [one, two]) {
    await send(db, { opId: ulid('op'), chatId, actorId: me,
                     messageId: ulid('msg'), body: 'parallel' });
  }
  assert.deepEqual(await log(chatStream(one.chatId)), [[1, 'message.created']]);
  assert.deepEqual(await log(chatStream(two.chatId)), [[1, 'message.created']]);
});

test('streamName is the stable spelling used in frames and logs', opts, async () => {
  assert.equal(streamName(chatStream('cht_1')), 'chat:cht_1');
  assert.equal(streamName(spaceStream('spc_1')), 'space:spc_1');
  assert.equal(streamName(workspaceStream('wsp_1')), 'workspace:wsp_1');
});
