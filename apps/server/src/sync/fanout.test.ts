// Who receives what — step 6 of the sync build plan (docs/SYNC-FLOWS.md §2).
//
// The claim under test is one sentence: an event computes its own audience, so
// there is nothing to revoke. Everything below is a way that could be false.
//
// Against fake deliveries rather than real sockets, deliberately. What is being
// asserted is which ACTORS an event reaches and why — a question about
// memberships and a predicate, not about frames on a wire. The socket's own
// tests cover the wire; putting real sockets here would make an authorization
// test fail for timing reasons.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSE } from '@relayed/protocol';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import {
  createChannel, addToSpace, leaveSpace, removeFromSpace, joinSpace,
} from './spaces.ts';
import { send, deleteMessage, writeMessage } from './ops.ts';
import { audienceFor, fanout, pushToActor, BACKLOG_LIMIT_BYTES } from './fanout.ts';
import { Registry, type Delivery } from './registry.ts';
import { recordActor } from './directory.ts';
import { workspaceStream, type AppendedEvent } from './events.ts';
import { allocateStream } from './allocate.ts';
import { appendEvent } from './events.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const other = ulid('wsp');          // a second workspace in the same org
const alice = ulid('act');
const bob = ulid('act');
const carol = ulid('act');          // in the workspace, never in the space

before(async () => {
  if (!up) return;
  await db.insertInto('organizations')
    .values({ id: org, workos_org_id: `test_${org}`, name: 'Fanout' }).execute();
  for (const id of [wsp, other]) {
    await db.insertInto('workspaces')
      .values({ id, org_id: org, name: 'Fanout', slug: `f-${id.slice(-8).toLowerCase()}` })
      .execute();
  }
  for (const id of [alice, bob, carol]) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type: 'human',
      handle: `f-${id.slice(-6).toLowerCase()}`, display_name: 'Fanout Test',
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
  for (const id of [wsp, other]) {
    await db.deleteFrom('sync_events').where('workspace_id', '=', id).execute();
    await db.deleteFrom('spaces').where('workspace_id', '=', id).execute();
    await db.deleteFrom('memberships').where('scope_id', '=', id).execute();
  }
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

// ─── a delivery target that records rather than transmits ───────────────────

class FakeDelivery implements Delivery {
  actorId: string;
  workspaceId: string;
  backlog = 0;
  received: { t: string; body: Record<string, unknown> }[] = [];
  droppedWith: number | null = null;

  constructor(actorId: string, workspaceId = wsp) {
    this.actorId = actorId;
    this.workspaceId = workspaceId;
  }
  send(t: string, body: Record<string, unknown>): void { this.received.push({ t, body }); }
  drop(code: number): void { this.droppedWith = code; }
  get events(): { type: string; rev: number }[] {
    return this.received
      .filter(f => f.t === 'ev')
      .map(f => ({ type: String(f.body['type']), rev: Number(f.body['rev']) }));
  }
}

/** A channel with alice as admin and bob as a member; carol is left out. */
async function channel(visibility: 'public' | 'private' = 'public') {
  const made = await createChannel(db, {
    workspaceId: wsp, name: `c-${ulid('x')}`, visibility, createdBy: alice,
  });
  await addToSpace(db, made.spaceId, bob, alice, ulid('msg'));
  return made;
}

const say = async (chatId: string, actorId: string, body: string) => {
  const { event } = await send(db, {
    opId: ulid('op'), chatId, actorId, messageId: ulid('msg'), body,
  });
  return event as AppendedEvent;
};

// ─── the audience is entitlement, not presence ──────────────────────────────

test('a chat event reaches every member of its space', opts, async () => {
  const { chatId } = await channel();
  const audience = await audienceFor(db, await say(chatId, alice, 'hello'));
  assert.deepEqual(audience.sort(), [alice, bob].sort());
});

test('somebody in the workspace but not the space is NOT in the audience',
  opts, async () => {
    // The space is the permission unit. Being in the building is not being in
    // the room, and a public channel is discoverable rather than delivered.
    const { chatId } = await channel();
    const audience = await audienceFor(db, await say(chatId, alice, 'hello'));
    assert.equal(audience.includes(carol), false);
  });

test('the audience is computed at SEND time, so a removal needs no revocation',
  opts, async () => {
    // The single sentence this whole file exists to demonstrate. Bob is in the
    // audience, then he is removed, then he is not — with nothing in between
    // that had to be found and undone.
    const { spaceId, chatId } = await channel();
    const before = await audienceFor(db, await say(chatId, alice, 'first'));
    assert.ok(before.includes(bob));

    await removeFromSpace(db, spaceId, bob, alice);

    const after = await audienceFor(db, await say(chatId, alice, 'second'));
    assert.equal(after.includes(bob), false,
      'absent from the very next answer — no subscription was revoked');
  });

test('re-adding puts them back, with nothing to re-subscribe', opts, async () => {
  const { spaceId, chatId } = await channel();
  await removeFromSpace(db, spaceId, bob, alice);
  await joinSpace(db, spaceId, bob);
  const audience = await audienceFor(db, await say(chatId, alice, 'welcome back'));
  assert.ok(audience.includes(bob));
});

test('a deleted chat has NO audience rather than a guessed one', opts, async () => {
  // Failing closed. The alternative is to assume, and a wrong assumption here
  // sends a message to somebody who cannot see the chat it belongs to.
  const { chatId } = await channel();
  const event = await say(chatId, alice, 'doomed');
  await db.deleteFrom('spaces')
    .where('id', 'in', eb => eb.selectFrom('chats').select('space_id')
      .where('id', '=', chatId))
    .execute();
  assert.deepEqual(await audienceFor(db, event), []);
});

// ─── the private-chat predicate, with space membership LEADING ──────────────

test('a private chat is the INTERSECTION, and the space conjunct leads',
  opts, async () => {
    // Private chats are Phase 5, so these rows are written by hand. The branch
    // is tested now because getting the predicate backwards is an access leak
    // rather than a missing feature — and a branch with no test is a branch
    // that is wrong the first time it runs.
    const { spaceId } = await channel();
    const privateChat = ulid('cht');
    await db.insertInto('chats').values({
      id: privateChat, workspace_id: wsp, space_id: spaceId,
      kind: 'private', name: 'huddle', created_by_actor_id: alice,
    }).execute();
    // Alice and bob are in the space; only alice is in the chat.
    await db.insertInto('memberships').values({
      scope_type: 'chat', scope_id: privateChat, actor_id: alice, role: 'member',
    }).execute();

    const event = await say(privateChat, alice, 'just us');
    assert.deepEqual(await audienceFor(db, event), [alice],
      'a space member who is not a chat member gets nothing');
  });

test('an actor in the chat but REMOVED from the space receives nothing',
  opts, async () => {
    // Invariant 50, and the reason the conjuncts are ordered rather than merely
    // intersected. Bob keeps a chat membership row that nobody tombstoned; the
    // space check in front of it is what makes that row worthless.
    const { spaceId } = await channel();
    const privateChat = ulid('cht');
    await db.insertInto('chats').values({
      id: privateChat, workspace_id: wsp, space_id: spaceId,
      kind: 'private', name: 'huddle', created_by_actor_id: alice,
    }).execute();
    for (const actorId of [alice, bob]) {
      await db.insertInto('memberships').values({
        scope_type: 'chat', scope_id: privateChat, actor_id: actorId, role: 'member',
      }).execute();
    }

    const before = await audienceFor(db, await say(privateChat, alice, 'both'));
    assert.deepEqual(before.sort(), [alice, bob].sort());

    // Removed from the SPACE only. The chat row is deliberately left behind.
    await removeFromSpace(db, spaceId, bob, alice);
    const stale = await db.selectFrom('memberships').select('actor_id')
      .where('scope_type', '=', 'chat').where('scope_id', '=', privateChat)
      .where('actor_id', '=', bob).where('left_at', 'is', null).executeTakeFirst();
    assert.ok(stale, 'the stale chat membership is still there — that is the point');

    const after = await audienceFor(db, await say(privateChat, alice, 'just me now'));
    assert.deepEqual(after, [alice], 'the stale row granted nothing');
  });

// ─── the other stream kinds ─────────────────────────────────────────────────

test('a space event reaches that space, not the workspace', opts, async () => {
  const { spaceId } = await channel();
  const result = await addToSpace(db, spaceId, carol, alice, ulid('msg'));
  if (result.status !== 'added') throw new Error('expected the add to succeed');
  const audience = await audienceFor(db, result.membershipEvent);
  assert.deepEqual(audience.sort(), [alice, bob, carol].sort());
});

test('the directory reaches the whole workspace — the one stream that does',
  opts, async () => {
    // Earned rather than assumed: everyone is entitled to ALL of it, so no
    // recipient ends up with a cursor full of holes (DESIGN.md §9.9).
    const event = await db.transaction().execute(trx => recordActor(trx, 'actor.updated', {
      id: bob, workspaceId: wsp, type: 'human', handle: 'bob',
      displayName: 'Bob', avatarUrl: null, ownerActorId: null, state: 'active',
    }).then(async () => appendEvent(
      trx, await allocateStream(trx, workspaceStream(wsp)),
      'actor.updated',
      { id: bob, type: 'human', handle: 'bob', display_name: 'Bob',
        avatar_url: null, owner_actor_id: null, state: 'active' }, { kind: 'stream' })));

    const audience = await audienceFor(db, event);
    assert.deepEqual(audience.sort(), [alice, bob, carol].sort(),
      'including carol, who is in no space at all');
  });

// ─── delivery ───────────────────────────────────────────────────────────────

test('every device of every audience member receives it', opts, async () => {
  // Keyed by actor, not device: two connections for one person is the ordinary
  // case, not a special one.
  const registry = new Registry();
  const laptop = new FakeDelivery(alice);
  const desktop = new FakeDelivery(alice);
  const bobs = new FakeDelivery(bob);
  const carols = new FakeDelivery(carol);
  for (const target of [laptop, desktop, bobs, carols]) registry.add(target);

  const { chatId } = await channel();
  const result = await fanout(db, registry, await say(chatId, alice, 'hi'));

  assert.deepEqual(result, { audience: 2, delivered: 3, dropped: 0, withheld: 0 });
  assert.equal(laptop.events.length, 1, 'both of alice’s devices');
  assert.equal(desktop.events.length, 1);
  assert.equal(bobs.events.length, 1);
  assert.equal(carols.events.length, 0, 'not in the space, not delivered to');
});

test('the ev frame carries the stream, the rev and the payload', opts, async () => {
  const registry = new Registry();
  const target = new FakeDelivery(alice);
  registry.add(target);

  const { chatId } = await channel();
  const event = await say(chatId, alice, 'shipped it');
  await fanout(db, registry, event);

  const [frame] = target.received;
  assert.equal(frame?.t, 'ev');
  assert.deepEqual(frame?.body['stream'], { kind: 'chat', id: chatId });
  assert.equal(frame?.body['rev'], event.rev);
  assert.equal(frame?.body['type'], 'message.created');
  assert.equal((frame?.body['payload'] as { body: string }).body, 'shipped it');
});

test('an event does NOT cross into another workspace’s connection', opts, async () => {
  // Not redundant with the audience, which is a set of ACTORS. One person may
  // hold connections to several workspaces at once, and an event reaching the
  // wrong one is an access leak that no permission check would catch — because
  // delivery is not a permission check.
  const registry = new Registry();
  const here = new FakeDelivery(alice, wsp);
  const elsewhere = new FakeDelivery(alice, other);
  registry.add(here);
  registry.add(elsewhere);

  const { chatId } = await channel();
  await fanout(db, registry, await say(chatId, alice, 'tenant-bound'));

  assert.equal(here.events.length, 1);
  assert.equal(elsewhere.events.length, 0, 'same actor, wrong workspace');
});

test('a delete fans out like any other event', opts, async () => {
  const registry = new Registry();
  const target = new FakeDelivery(bob);
  registry.add(target);

  const { chatId } = await channel();
  const messageId = ulid('msg');
  await send(db, { opId: ulid('op'), chatId, actorId: alice, messageId, body: 'oops' });
  const { event } = await deleteMessage(db, {
    opId: ulid('op'), chatId, actorId: alice, messageId,
  });
  await fanout(db, registry, event as AppendedEvent);

  assert.deepEqual(target.events.map(e => e.type), ['message.deleted']);
});

test('a REPLAYED op produces no event, so nothing is fanned out twice',
  opts, async () => {
    // The subtlety in returning the event from a closure. A retried op returns
    // the stored ack without running the work — so if the event leaked out of
    // the first attempt, every other device would receive the message twice
    // while the sender's own ack correctly reported one.
    const { chatId } = await channel();
    const input = {
      opId: ulid('op'), chatId, actorId: alice, messageId: ulid('msg'), body: 'once',
    };
    const first = await send(db, input);
    const replay = await send(db, input);

    assert.ok(first.event, 'the first attempt did the work');
    assert.equal(replay.event, undefined, 'the replay did not');
    assert.deepEqual(replay.ack, first.ack, 'and returned the stored ack');
  });

test('a fanout with nobody connected still reports its audience', opts, async () => {
  // Entitlement and presence are different questions. The audience size is what
  // says whether an event mattered; delivered says who happened to be there.
  const { chatId } = await channel();
  const result = await fanout(db, new Registry(), await say(chatId, alice, 'alone'));
  assert.deepEqual(result, { audience: 2, delivered: 0, dropped: 0, withheld: 0 });
});

// ─── messages only some people can see (WORKSPACE-AGENTS.md §8.6) ──────────

/** A notice for `listed`, written the way the server's own writers will. */
const notice = (chatId: string, authorId: string, listed: string[]) =>
  db.transaction().execute(trx => writeMessage(trx, {
    kind: 'actor',
    chatId, messageId: ulid('msg'), authorId, body: 'a private notice', parentId: null,
    audience: { kind: 'listed', actors: listed },
  }));

test('a notice reaches the listed with its content and every other reader as its '
   + 'revision alone', opts, async () => {
  const registry = new Registry();
  const alices = new FakeDelivery(alice);
  const bobs = new FakeDelivery(bob);
  const carols = new FakeDelivery(carol);
  for (const target of [alices, bobs, carols]) registry.add(target);

  const { chatId } = await channel();
  const { event, ack } = await notice(chatId, alice, [alice]);
  const result = await fanout(db, registry, event);

  assert.deepEqual(result, { audience: 2, delivered: 2, dropped: 0, withheld: 1 });
  assert.deepEqual(alices.events, [{ type: 'message.created', rev: event.rev }]);
  assert.deepEqual(bobs.received, [{ t: 'ev', body: {
    stream: { kind: 'chat', id: chatId }, rev: event.rev, type: 'withheld', payload: {},
  } }], 'the revision, so his frontier passes it — and nothing else');
  assert.ok(!JSON.stringify(bobs.received).includes(ack.messageId), 'not even the id');
  assert.equal(carols.received.length, 0, 'not a reader of the chat, so not even that');
});

test('a LISTED actor who has left the room receives nothing — neither the content '
   + 'nor a withheld', opts, async () => {
  // The order §8.6 insists on: the chat's readers first, then the list. A list
  // that outlived someone's membership grants nothing, and nobody had to edit it.
  const registry = new Registry();
  const alices = new FakeDelivery(alice);
  const bobs = new FakeDelivery(bob);
  registry.add(alices);
  registry.add(bobs);

  const { spaceId, chatId } = await channel();
  const { ack } = await notice(chatId, alice, [alice, bob]);
  await leaveSpace(db, spaceId, bob);
  const { event } = await deleteMessage(db, {
    opId: ulid('op'), chatId, actorId: alice, messageId: ack.messageId });
  await fanout(db, registry, event as AppendedEvent);

  assert.deepEqual(alices.events.map(e => e.type), ['message.deleted']);
  assert.equal(bobs.received.length, 0);
});

test('the delete of a notice is withheld from the people its creation was', opts, async () => {
  const registry = new Registry();
  const bobs = new FakeDelivery(bob);
  registry.add(bobs);

  const { chatId } = await channel();
  const { ack } = await notice(chatId, alice, [alice]);
  const { event } = await deleteMessage(db, {
    opId: ulid('op'), chatId, actorId: alice, messageId: ack.messageId });
  await fanout(db, registry, event as AppendedEvent);

  assert.deepEqual(bobs.events.map(e => e.type), ['withheld']);
});

// ─── the slow consumer ──────────────────────────────────────────────────────

test('a socket past the backlog limit is dropped, not buffered', opts, async () => {
  // Safe only because durable catch-up exists: everything it missed is still in
  // the log, so reconnecting replays it. Without that, the choice would be
  // unbounded memory or a silent permanent hole.
  const registry = new Registry();
  const healthy = new FakeDelivery(alice);
  const stuck = new FakeDelivery(bob);
  stuck.backlog = BACKLOG_LIMIT_BYTES + 1;
  registry.add(healthy);
  registry.add(stuck);

  const { chatId } = await channel();
  const result = await fanout(db, registry, await say(chatId, alice, 'keep up'));

  assert.deepEqual(result, { audience: 2, delivered: 1, dropped: 1, withheld: 0 });
  assert.equal(stuck.droppedWith, CLOSE.slowConsumer);
  assert.equal(stuck.events.length, 0, 'and was not written to as well as dropped');
  assert.equal(healthy.events.length, 1);
});

test('a socket AT the limit is still written to', opts, async () => {
  // The boundary, asserted because an off-by-one here disconnects healthy
  // clients under load — which looks exactly like the problem it is meant to
  // relieve.
  const registry = new Registry();
  const target = new FakeDelivery(alice);
  target.backlog = BACKLOG_LIMIT_BYTES;
  registry.add(target);

  const { chatId } = await channel();
  await fanout(db, registry, await say(chatId, alice, 'borderline'));
  assert.equal(target.droppedWith, null);
  assert.equal(target.events.length, 1);
});

// ─── addressed to an actor rather than ordered in a stream ──────────────────

test('pushToActor reaches every device of one actor and nobody else',
  opts, async () => {
    // Read state and counter snapshots take this path: no revision, no log row,
    // no cursor — a max register cannot be applied wrongly by being applied
    // late, so a missed push is repaired by the next `welcome`.
    const registry = new Registry();
    const laptop = new FakeDelivery(alice);
    const phone = new FakeDelivery(alice);
    const bobs = new FakeDelivery(bob);
    for (const t of [laptop, phone, bobs]) registry.add(t);

    const delivered = pushToActor(registry, alice, wsp, 'counters',
      { c: 'cht_1', chat_unread: 7 });

    assert.equal(delivered, 2);
    assert.equal(laptop.received[0]?.t, 'counters');
    assert.equal(phone.received.length, 1);
    assert.equal(bobs.received.length, 0);
  });

// ─── the registry itself ────────────────────────────────────────────────────

test('the registry empties its key when the last device goes', opts, () => {
  // A map that only ever grows is a leak whose symptom is memory, months later,
  // on the busiest server.
  const registry = new Registry();
  const one = new FakeDelivery(alice);
  const two = new FakeDelivery(alice);
  registry.add(one);
  registry.add(two);
  assert.equal(registry.size(), 2);
  assert.equal(registry.actors(), 1, 'two connections, one person');

  registry.remove(one);
  assert.equal(registry.actors(), 1);
  registry.remove(two);
  assert.equal(registry.actors(), 0, 'and the key is gone, not left empty');
  assert.equal(registry.size(), 0);
});

test('the registry holds no authorization — only who is reachable', opts, () => {
  // Stated as a test because it is the architectural claim, and a future
  // "optimisation" that caches an audience on a connection would have to delete
  // this to pass. There is nothing here to consult about entitlement.
  const registry = new Registry();
  const target = new FakeDelivery(alice);
  registry.add(target);
  const surface = Object.keys(target) as (keyof FakeDelivery)[];
  for (const forbidden of ['spaces', 'chats', 'subscriptions', 'audience', 'grants']) {
    assert.equal(surface.includes(forbidden as keyof FakeDelivery), false,
      `a Delivery must not carry ${forbidden}`);
  }
});

test('removing a connection that was never added is harmless', opts, () => {
  const registry = new Registry();
  registry.remove(new FakeDelivery(alice));
  assert.equal(registry.size(), 0);
});

// ─── membership events reach the remaining members ─────────────────────────

test('the removed actor does not receive their own removal', opts, async () => {
  // Deliberate, and worth asserting because it reads as a bug. Fanout resolves
  // the audience from committed membership, and by then they are not a member.
  // They learn of it on their next reconnect, when the space is simply absent
  // from `welcome`; until then their local copy freezes (DESIGN.md §6.6).
  const registry = new Registry();
  const alices = new FakeDelivery(alice);
  const bobs = new FakeDelivery(bob);
  registry.add(alices);
  registry.add(bobs);

  const { spaceId } = await channel();
  const event = await removeFromSpace(db, spaceId, bob, alice);
  await fanout(db, registry, event);

  assert.deepEqual(alices.events.map(e => e.type), ['space.member_removed']);
  assert.equal(bobs.events.length, 0, 'the person removed hears nothing');
});

test('leaving tells the people still there', opts, async () => {
  const registry = new Registry();
  const alices = new FakeDelivery(alice);
  registry.add(alices);

  const { spaceId } = await channel();
  await fanout(db, registry, await leaveSpace(db, spaceId, bob));
  assert.deepEqual(alices.events.map(e => e.type), ['space.member_removed']);
});
