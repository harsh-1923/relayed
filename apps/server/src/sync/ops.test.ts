// The write rules for messages only some people can see
// (docs/WORKSPACE-AGENTS.md §8.7, §8.8), against Postgres.
//
// The read paths are in feed.test.ts and delivery in fanout.test.ts. What is
// here is what `writeMessage` refuses and what it does not do — the rules no
// writer may skip, whichever writer it is.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { Forbidden } from '../authz/can.ts';
import { createChannel, addToSpace, joinSpace } from './spaces.ts';
import {
  send, deleteMessage, writeMessage, updateMessage, MessageNotFoundError, type MessageWrite,
} from './ops.ts';
import { catchup, repair } from './feed.ts';
import { chatStream } from './events.ts';
import { AudienceError } from './visibility.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const me = ulid('act');
const bob = ulid('act');
const agent = ulid('act');       // the author of a restricted message
const outsider = ulid('act');    // in the workspace, never in the room
const triage = ulid('act');      // type='agent' — the mention-starts-a-run tests (WORKSPACE-AGENTS.md §5.1)

before(async () => {
  if (!up) return;
  await db.insertInto('organizations')
    .values({ id: org, workos_org_id: `test_${org}`, name: 'Ops' }).execute();
  await db.insertInto('workspaces')
    .values({ id: wsp, org_id: org, name: 'Ops', slug: `o-${wsp.slice(-6).toLowerCase()}` })
    .execute();
  for (const id of [me, bob, agent, outsider]) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type: 'human',
      handle: `o-${id.slice(-6).toLowerCase()}`, display_name: 'Ops Test',
      avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${id}`,
      owner_actor_id: null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({
      scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member',
    }).execute();
  }
  await db.insertInto('actors').values({
    id: triage, org_id: org, workspace_id: wsp, type: 'agent',
    handle: `o-${triage.slice(-6).toLowerCase()}`, display_name: 'Triage',
    avatar_url: null, identity_kind: 'system', identity_id: null,
    owner_actor_id: me, provisioned_by: 'api', state: 'active',
  }).execute();
  await db.insertInto('memberships').values({
    scope_type: 'workspace', scope_id: wsp, actor_id: triage, role: 'member',
  }).execute();
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

/** A channel: `me` its admin, `bob` a member, `agent` joined. `outsider` is not in it. */
async function room() {
  const made = await createChannel(db, { workspaceId: wsp, name: `r-${ulid('x')}`, createdBy: me });
  await addToSpace(db, made.spaceId, bob, me);
  await joinSpace(db, made.spaceId, agent);
  return made;
}

const write = (input: { chatId: string; audience: MessageWrite['audience'];
                        parentId?: string | null; body?: string; authorId?: string }) =>
  db.transaction().execute(trx => writeMessage(trx, {
    messageId: ulid('msg'), authorId: input.authorId ?? agent, parentId: input.parentId ?? null,
    chatId: input.chatId, audience: input.audience, body: input.body ?? 'a private notice',
  }));

const activity = async (spaceId: string): Promise<number> => {
  const row = await db.selectFrom('spaces').select('last_activity_at')
    .where('id', '=', spaceId).executeTakeFirstOrThrow();
  return new Date(row.last_activity_at as unknown as string).getTime();
};

test('a notice does NOT move the room\'s activity clock; a message to the chat does',
  opts, async () => {
  // Otherwise the room jumps to the top of bob's sidebar with nothing in it
  // he can see (§8.7, room activity).
  const { spaceId, chatId } = await room();
  await db.updateTable('spaces').set({ last_activity_at: sql`'2020-01-01T00:00:00Z'::timestamptz` })
    .where('id', '=', spaceId).execute();
  const stale = await activity(spaceId);

  await write({ chatId, audience: { kind: 'listed', actors: [me] } });
  assert.equal(await activity(spaceId), stale, 'unmoved by the notice');

  await write({ chatId, audience: { kind: 'stream' } });
  assert.ok(await activity(spaceId) > stale, 'moved by a message everyone can see');
});

test('every listed actor must be able to READ THE CHAT, and a refusal writes nothing',
  opts, async () => {
  // A notice addressed to someone outside the room would sit in the log naming
  // them, delivered to nobody (§8.8).
  const { chatId } = await room();
  const before = await db.selectFrom('chats').select(['next_ord', 'next_rev'])
    .where('id', '=', chatId).executeTakeFirstOrThrow();

  await assert.rejects(() => write({ chatId, audience: { kind: 'listed', actors: [me, outsider] } }),
    (err: Error) => {
      assert.ok(err instanceof AudienceError);
      assert.equal(err.reason, 'cannot_read');
      assert.equal(err.actorId, outsider);
      return true;
    });

  const after = await db.selectFrom('chats').select(['next_ord', 'next_rev'])
    .where('id', '=', chatId).executeTakeFirstOrThrow();
  assert.deepEqual(after, before, 'no ordinal, no revision, no row');
});

test('an EMPTY list is refused — never read as everyone, nor as no one', opts, async () => {
  const { chatId } = await room();
  await assert.rejects(() => write({ chatId, audience: { kind: 'listed', actors: [] } }),
    (err: Error) => err instanceof AudienceError && err.reason === 'empty');
});

test('the stored list is sorted and has no repeats', opts, async () => {
  const { chatId } = await room();
  const sorted = [me, bob].sort();
  const { ack } = await write({ chatId, audience: { kind: 'listed', actors: [bob, me, bob] } });
  const row = await db.selectFrom('messages').select('visible_to')
    .where('id', '=', ack.messageId).executeTakeFirstOrThrow();
  assert.deepEqual(row.visible_to, sorted);
});

test('NOTHING REPLIES TO A NOTICE: not found to someone it is hidden from, '
   + 'forbidden to someone it is not', opts, async () => {
  // A thread under a restricted message would need every reply restricted too
  // (§8.8). Refused as not-found to bob, the answer an id that does not exist
  // gets, so the refusal tells him nothing about the notice.
  const { chatId } = await room();
  const { ack } = await write({ chatId, audience: { kind: 'listed', actors: [me] } });

  await assert.rejects(() => send(db, {
    opId: ulid('op'), chatId, actorId: bob, messageId: ulid('msg'),
    body: 'what notice?', parentId: ack.messageId,
  }), (err: Error) => err instanceof MessageNotFoundError);

  await assert.rejects(() => send(db, {
    opId: ulid('op'), chatId, actorId: me, messageId: ulid('msg'),
    body: 'thanks', parentId: ack.messageId,
  }), (err: Error) => err instanceof Forbidden);
});

test('a notice is a valid REPLY to a message everyone can see', opts, async () => {
  // A restricted message may itself be a reply, in a thread everyone can read.
  const { chatId } = await room();
  const root = ulid('msg');
  await send(db, { opId: ulid('op'), chatId, actorId: me, messageId: root, body: '@triage file this' });
  const { event } = await write({ chatId, parentId: root, audience: { kind: 'listed', actors: [me] } });
  assert.deepEqual(event.audience, { kind: 'listed', actors: [me] });
});

test('DELETING a notice you cannot see reads as not found, even for an admin', opts, async () => {
  // Checked before the author is compared: `forbidden` would confirm there is
  // something there. `me` is the room's admin, and moderation is not a reason
  // to learn a notice exists.
  const { chatId } = await room();
  const { ack } = await write({ chatId, audience: { kind: 'listed', actors: [bob] } });

  await assert.rejects(() => deleteMessage(db, {
    opId: ulid('op'), chatId, actorId: me, messageId: ack.messageId,
  }), (err: Error) => err instanceof MessageNotFoundError);

  // Bob may see it, so he is told the truth: it is not his to delete. Listed is
  // read access, not authorship, and not moderation.
  await assert.rejects(() => deleteMessage(db, {
    opId: ulid('op'), chatId, actorId: bob, messageId: ack.messageId,
  }), (err: Error) => err instanceof Forbidden);
});

test('a notice\'s delete is addressed to the notice\'s own list', opts, async () => {
  const { chatId } = await room();
  const { ack } = await write({ chatId, audience: { kind: 'listed', actors: [me] } });
  const { event } = await deleteMessage(db, {
    opId: ulid('op'), chatId, actorId: me, messageId: ack.messageId,
  });
  assert.deepEqual(event?.audience, { kind: 'listed', actors: [me] });

  const row = await db.selectFrom('sync_events').select('visible_to')
    .where('event_id', '=', event?.eventId ?? '').executeTakeFirstOrThrow();
  assert.deepEqual(row.visible_to, [me], 'and the log row carries the list');
});

test('a client send is always for the whole chat', opts, async () => {
  const { chatId } = await room();
  const { event, ack } = await send(db, {
    opId: ulid('op'), chatId, actorId: bob, messageId: ulid('msg'), body: 'hello',
  });
  assert.deepEqual(event?.audience, { kind: 'stream' });
  const row = await db.selectFrom('messages').select('visible_to')
    .where('id', '=', ack.messageId).executeTakeFirstOrThrow();
  assert.equal(row.visible_to, null);
  assert.equal((event?.payload as Record<string, unknown>)['visible_to'], undefined,
    'and its payload carries no list');
});

// ── the mention → run handoff (WORKSPACE-AGENTS.md §5.1, §5.2) ──────────────
//
// Inserted inside the SAME transaction as the message and its event, so a
// replayed op cannot start a second run — the same idempotency guarantee the
// message write itself gets from `applyOnce`.

test('mentioning a member agent starts exactly one run, in the same send', opts, async () => {
  const { chatId } = await room();
  await joinSpace(db, (await db.selectFrom('chats').select('space_id')
    .where('id', '=', chatId).executeTakeFirstOrThrow()).space_id, triage);
  const { ack, runIds } = await send(db, {
    opId: ulid('op'), chatId, actorId: bob, messageId: ulid('msg'),
    body: `[Triage](actor:${triage}) can you help`,
  });
  assert.equal(runIds.length, 1);

  const run = await db.selectFrom('agent_runs')
    .select(['agent_actor_id', 'invoker_actor_id', 'chat_id', 'trigger_message_id', 'state', 'workspace_id'])
    .where('id', '=', runIds[0] ?? '').executeTakeFirstOrThrow();
  assert.deepEqual(run, {
    agent_actor_id: triage, invoker_actor_id: bob, chat_id: chatId,
    trigger_message_id: ack.messageId, state: 'queued', workspace_id: wsp,
  });
});

test('a replayed op does not start a second run for the same mention', opts, async () => {
  const { chatId } = await room();
  await joinSpace(db, (await db.selectFrom('chats').select('space_id')
    .where('id', '=', chatId).executeTakeFirstOrThrow()).space_id, triage);
  const opId = ulid('op');
  const messageId = ulid('msg');
  const body = `[Triage](actor:${triage}) again please`;

  const first = await send(db, { opId, chatId, actorId: bob, messageId, body });
  const replay = await send(db, { opId, chatId, actorId: bob, messageId, body });

  assert.equal(first.runIds.length, 1);
  assert.equal(replay.runIds.length, 0, 'a replay reaches the stored ack and never reaches the insert');

  const rows = await db.selectFrom('agent_runs').select('id')
    .where('trigger_message_id', '=', messageId).execute();
  assert.equal(rows.length, 1, 'exactly one run for the mention, however many times the op is retried');
});

test('mentioning an agent that is not a member of the chat starts no run', opts, async () => {
  const { chatId } = await room();   // `triage` never joins this room's space
  const { runIds } = await send(db, {
    opId: ulid('op'), chatId, actorId: bob, messageId: ulid('msg'),
    body: `[Triage](actor:${triage}) hello`,
  });
  assert.deepEqual(runIds, []);
});

test('a message with no mention starts no run', opts, async () => {
  const { chatId } = await room();
  const { runIds } = await send(db, {
    opId: ulid('op'), chatId, actorId: bob, messageId: ulid('msg'), body: 'just talking to Bob',
  });
  assert.deepEqual(runIds, []);
});

// ── message.updated: the server replacing a message's content ───────────────
//
// An access card's state changes for everyone in the thread (§7.4). The event
// is ordinary: a revision, no ordinal, the version rule bumping the message —
// which is what lets a client that missed it be put right by repair.

const update = (chatId: string, messageId: string, body: string) =>
  db.transaction().execute(trx => updateMessage(trx, { chatId, messageId, body }));

test('an update takes a revision and NO ordinal, bumps the message\'s version, '
   + 'and reaches catch-up and repair', opts, async () => {
  const { chatId } = await room();
  const { ack } = await write({ chatId, body: 'waiting for Alice', audience: { kind: 'stream' } });
  const before = await db.selectFrom('chats').select(['next_ord', 'next_rev'])
    .where('id', '=', chatId).executeTakeFirstOrThrow();

  const event = await update(chatId, ack.messageId, 'Alice gave @triage access');

  const after = await db.selectFrom('chats').select(['next_ord', 'next_rev'])
    .where('id', '=', chatId).executeTakeFirstOrThrow();
  assert.equal(after.next_ord, before.next_ord, 'no ordinal: nothing new to be unread');
  assert.equal(after.next_rev, before.next_rev + 1);
  assert.deepEqual(event.payload, { id: ack.messageId, body: 'Alice gave @triage access' });
  assert.deepEqual(event.audience, { kind: 'stream' });

  const row = await db.selectFrom('messages').select(['body', 'rev', 'edited_at'])
    .where('id', '=', ack.messageId).executeTakeFirstOrThrow();
  assert.deepEqual(row, { body: 'Alice gave @triage access', rev: event.rev, edited_at: null },
    'the version moved, and nothing marked it edited');

  const replay = await catchup(db, bob, chatStream(chatId), before.next_rev);
  assert.ok(replay.kind === 'replay');
  assert.deepEqual(replay.events.map(e => e.type), ['message.updated']);

  // A client that gapped from before the update gets the row back from repair.
  const repaired = await repair(db, bob, chatId, before.next_rev, 99, null);
  assert.deepEqual(repaired.map(r => [r.id, r.body]), [[ack.messageId, 'Alice gave @triage access']]);
});

test('an update to a tombstone, or to a message in another chat, is not found and '
   + 'allocates nothing', opts, async () => {
  const { chatId } = await room();
  const other = await room();
  const { ack } = await write({ chatId, audience: { kind: 'stream' } });

  await assert.rejects(() => update(other.chatId, ack.messageId, 'x'),
    (err: Error) => err instanceof MessageNotFoundError);

  await deleteMessage(db, { opId: ulid('op'), chatId, actorId: agent, messageId: ack.messageId });
  const before = await db.selectFrom('chats').select('next_rev')
    .where('id', '=', chatId).executeTakeFirstOrThrow();
  await assert.rejects(() => update(chatId, ack.messageId, 'back to life'),
    (err: Error) => err instanceof MessageNotFoundError);
  const after = await db.selectFrom('chats').select('next_rev')
    .where('id', '=', chatId).executeTakeFirstOrThrow();
  assert.equal(after.next_rev, before.next_rev, 'the allocation rolled back with the refusal');
});

test('an update to a restricted message goes to its own list', opts, async () => {
  // The dormant capability (§8) and the new event agree: nothing about a
  // restricted message reaches anyone its creation did not.
  const { chatId } = await room();
  const { ack } = await write({ chatId, audience: { kind: 'listed', actors: [me] } });
  const event = await update(chatId, ack.messageId, 'still only for you');
  assert.deepEqual(event.audience, { kind: 'listed', actors: [me] });

  const replay = await catchup(db, bob, chatStream(chatId), event.rev - 1);
  assert.ok(replay.kind === 'replay');
  assert.deepEqual(replay.events, [{ rev: event.rev, type: 'withheld', payload: {} }]);
});
