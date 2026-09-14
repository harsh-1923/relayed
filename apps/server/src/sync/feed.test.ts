// The domain ops, against Postgres — and the spike's assertions, ported.
//
// PHASE-2-SYNC.md step C's bar is "the same assertions, a new engine". The
// numbers below (8, 400, 50, 237, 4 pages, 202 unread, 2 mentions) are the
// spike's, kept identical on purpose: matching values across two engines and
// two implementations is evidence the behaviour transferred, where fresh
// numbers would only be evidence that something ran.
//
// The spike's SERVER half is what belongs here. Its client half — contiguity,
// applyGap, coalescing — is steps F and H, and is deliberately absent rather
// than half-ported.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { Forbidden } from '../authz/can.ts';
import {
  createChannel, joinSpace, addToSpace, leaveSpace, removeFromSpace,
  spaceMembers, SlugTakenError, UnknownWorkspaceError,
} from './spaces.ts';
import { send, deleteMessage, markRead, MessageNotFoundError } from './ops.ts';
import {
  head, catchup, backfill, repair, threadReplies, counters, welcome, eventsSince,
  GAP_THRESHOLD, REPLAY_LIMIT, type MessageRow,
} from './feed.ts';
import { chatStream } from './events.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const me = ulid('act');
const bob = ulid('act');
const stranger = ulid('act');

before(async () => {
  if (!up) return;
  await db.insertInto('organizations')
    .values({ id: org, workos_org_id: `test_${org}`, name: 'Feed' }).execute();
  await db.insertInto('workspaces')
    .values({ id: wsp, org_id: org, name: 'Feed', slug: `t-${wsp.slice(-6).toLowerCase()}` })
    .execute();
  for (const id of [me, bob, stranger]) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type: 'human',
      handle: `t-${id.slice(-6).toLowerCase()}`, display_name: 'Feed Test',
      avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${id}`,
      owner_actor_id: null, provisioned_by: 'api', state: 'active',
    }).execute();
    // can() needs the workspace membership above the space one: containment is
    // the leading conjunct, so a space row alone grants nothing (AUTHZ.md §7).
    await db.insertInto('memberships').values({
      scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member',
    }).execute();
  }
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

/** A channel with `me` as admin and `bob` as a member. */
async function channel() {
  const { spaceId, chatId } = await createChannel(db, {
    workspaceId: wsp, name: 'general', createdBy: me,
  });
  await addToSpace(db, spaceId, bob, me);
  return { spaceId, chatId };
}

/** n messages, from bob unless told otherwise. Bodies match the spike's. */
async function fill(chatId: string, n: number, author = bob) {
  for (let i = 1; i <= n; i++) {
    await send(db, {
      opId: ulid('op'), chatId, actorId: author, messageId: ulid('msg'),
      body: `message ${i}`,
    });
  }
}

// ── provisioning ───────────────────────────────────────────────────────────

test('a channel is created with its sole chat and its creator as admin', opts, async () => {
  const { spaceId, chatId } = await channel();
  const chat = await db.selectFrom('chats').select(['kind', 'space_id'])
    .where('id', '=', chatId).executeTakeFirstOrThrow();
  assert.equal(chat.kind, 'sole');
  assert.equal(chat.space_id, spaceId);

  const role = await db.selectFrom('memberships').select('role')
    .where('scope_type', '=', 'space').where('scope_id', '=', spaceId)
    .where('actor_id', '=', me).executeTakeFirstOrThrow();
  // Admin, so a space is never stranded when its creator is deprovisioned.
  assert.equal(role.role, 'admin');
});

test('someone outside the workspace cannot create a channel in it', opts, async () => {
  const outsider = ulid('act');
  await db.insertInto('actors').values({
    id: outsider, org_id: org, workspace_id: wsp, type: 'human',
    handle: `t-${outsider.slice(-6).toLowerCase()}`, display_name: 'Outsider',
    avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${outsider}`,
    owner_actor_id: null, provisioned_by: 'api', state: 'active' }).execute();
  // Deliberately NO workspace membership row.
  await assert.rejects(() => createChannel(db, {
    workspaceId: wsp, name: 'nope', createdBy: outsider,
  }), (err: Error) => { assert.ok(err instanceof Forbidden); return true; });
});

test('re-joining clears the tombstone rather than adding a second row', opts, async () => {
  const { spaceId } = await channel();
  await leaveSpace(db, spaceId, bob);
  assert.deepEqual(await spaceMembers(db, spaceId), [me]);
  await joinSpace(db, spaceId, bob);
  assert.deepEqual((await spaceMembers(db, spaceId)).sort(), [me, bob].sort());
  const rows = await db.selectFrom('memberships').select('actor_id')
    .where('scope_type', '=', 'space').where('scope_id', '=', spaceId)
    .where('actor_id', '=', bob).execute();
  assert.equal(rows.length, 1, 'one row, reused — which is what makes re-add a gap');
});

// ── joining, adding, leaving, removing ─────────────────────────────────────

test('anyone in the workspace may join an OPEN channel unasked', opts, async () => {
  // Public means discoverable and joinable, not auto-joined. This is the act
  // that turns discovery into membership — and it is the one space action that
  // cannot require space membership, because membership is what it creates.
  const { spaceId } = await channel();
  await joinSpace(db, spaceId, stranger);
  assert.ok((await spaceMembers(db, spaceId)).includes(stranger));
});

test('nobody may walk into a PRIVATE channel', opts, async () => {
  const { spaceId } = await createChannel(db, {
    workspaceId: wsp, name: 'secret', visibility: 'private', createdBy: me });
  await assert.rejects(() => joinSpace(db, spaceId, stranger),
    (err: Error) => { assert.ok(err instanceof Forbidden); return true; });
  // But a member may still add them, which is the deliberate asymmetry.
  await addToSpace(db, spaceId, stranger, me);
  assert.ok((await spaceMembers(db, spaceId)).includes(stranger));
});

test('joining needs workspace membership above it, open policy or not', opts, async () => {
  // The containment conjunct. An actor with no workspace row is not "not a
  // member of this space" — they are not in the building.
  const outsider = ulid('act');
  await db.insertInto('actors').values({
    id: outsider, org_id: org, workspace_id: wsp, type: 'human',
    handle: `t-${outsider.slice(-6).toLowerCase()}`, display_name: 'Outsider',
    avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${outsider}`,
    owner_actor_id: null, provisioned_by: 'api', state: 'active' }).execute();
  const { spaceId } = await channel();
  await assert.rejects(() => joinSpace(db, spaceId, outsider),
    (err: Error) => { assert.ok(err instanceof Forbidden); return true; });
});

test('a non-member cannot add somebody to a space', opts, async () => {
  const { spaceId } = await channel();
  await assert.rejects(() => addToSpace(db, spaceId, stranger, stranger),
    (err: Error) => { assert.ok(err instanceof Forbidden); return true; });
});

test('a plain member cannot remove another member — only a space admin may',
  opts, async () => {
  // The asymmetry with adding, and it matches make_public: adding a person is
  // reversible by that person, removing one is not.
  const { spaceId } = await channel();
  await addToSpace(db, spaceId, stranger, bob);

  await assert.rejects(() => removeFromSpace(db, spaceId, stranger, bob),
    (err: Error) => { assert.ok(err instanceof Forbidden); return true; });
  assert.ok((await spaceMembers(db, spaceId)).includes(stranger));

  // `me` created the channel and is therefore its admin.
  await removeFromSpace(db, spaceId, stranger, me);
  assert.ok(!(await spaceMembers(db, spaceId)).includes(stranger));
});

test('removing YOURSELF is leaving, and needs no permission', opts, async () => {
  // A rule that could refuse would be a rule that traps someone in a
  // conversation. bob is a plain member and may still walk out.
  const { spaceId } = await channel();
  await removeFromSpace(db, spaceId, bob, bob);
  assert.deepEqual(await spaceMembers(db, spaceId), [me]);

  await addToSpace(db, spaceId, bob, me);
  await leaveSpace(db, spaceId, bob);
  assert.deepEqual(await spaceMembers(db, spaceId), [me]);
});

// ── createChannel's inputs ─────────────────────────────────────────────────

test('the organisation is DERIVED, so it cannot disagree with the workspace',
  opts, async () => {
  // It used to be a parameter, and a caller could pass one org with another
  // org's workspace: `spaces` carries both as separate foreign keys and nothing
  // ties them together. Verified insertable before this changed.
  const { spaceId } = await channel();
  const row = await db.selectFrom('spaces')
    .innerJoin('workspaces', 'workspaces.id', 'spaces.workspace_id')
    .select(['spaces.org_id as space_org', 'workspaces.org_id as workspace_org'])
    .where('spaces.id', '=', spaceId).executeTakeFirstOrThrow();
  assert.equal(row.space_org, row.workspace_org);
  assert.equal(row.space_org, org);
});

test('an unknown workspace is refused as FORBIDDEN, not as not-found', opts, async () => {
  // The permission check runs before the existence lookup, deliberately: a
  // workspace you cannot reach and a workspace that is not there must give the
  // same answer, or the error message becomes a directory. Same ordering as
  // deleteMessage, for the same reason.
  await assert.rejects(() => createChannel(db, {
    workspaceId: 'wsp_nonexistent', name: 'nowhere', createdBy: me,
  }), (err: Error) => { assert.ok(err instanceof Forbidden); return true; });
});

test('a membership outliving its workspace surfaces as not-found', opts, async () => {
  // Which is how UnknownWorkspaceError is actually reached. `memberships` is
  // polymorphic, so `scope_id` cannot carry a foreign key and a grant can
  // outlive the thing it grants. The permission check then passes and the
  // lookup is what catches it — an explicit error rather than an insert that
  // fails somewhere deeper on a foreign key.
  const ghost = ulid('wsp');
  await db.insertInto('memberships').values({
    scope_type: 'workspace', scope_id: ghost, actor_id: me, role: 'member' }).execute();
  try {
    await assert.rejects(() => createChannel(db, {
      workspaceId: ghost, name: 'ghost', createdBy: me,
    }), (err: Error) => { assert.ok(err instanceof UnknownWorkspaceError); return true; });
  } finally {
    await db.deleteFrom('memberships').where('scope_id', '=', ghost).execute();
  }
});

test('a slug already taken in the workspace is reported, not swallowed', opts, async () => {
  const slug = `dup-${ulid('s').slice(-8).toLowerCase()}`;
  await createChannel(db, { workspaceId: wsp, name: 'first', slug, createdBy: me });
  await assert.rejects(
    () => createChannel(db, { workspaceId: wsp, name: 'second', slug, createdBy: me }),
    (err: Error) => {
      assert.ok(err instanceof SlugTakenError);
      assert.equal((err as SlugTakenError).slug, slug);
      return true;
    });
});

// ── sending, and who may ───────────────────────────────────────────────────

test('a member sends; the head advances', opts, async () => {
  const { chatId } = await channel();
  const { ack } = await send(db, {
    opId: ulid("op"), chatId, actorId: bob, messageId: ulid("msg"), body: "hello",
  });
  assert.equal(ack.ord, 1);
  assert.equal(ack.rev, 1);
  assert.deepEqual(await head(db, chatId), { headOrd: 1, headRev: 1 });
});

test('a non-member cannot send, and cannot read either', opts, async () => {
  // Space membership is the LEADING conjunct of chat access, so this is denied
  // by containment rather than by a rule about chats (DESIGN.md §7.3).
  const { chatId } = await channel();
  await assert.rejects(() => send(db, {
    opId: ulid('op'), chatId, actorId: stranger, messageId: ulid('msg'), body: 'hi',
  }), (err: Error) => { assert.ok(err instanceof Forbidden); return true; });
  await assert.rejects(() => markRead(db, stranger, chatId, 1),
    (err: Error) => { assert.ok(err instanceof Forbidden); return true; });
});

test('a member removed from the space stops being able to send', opts, async () => {
  const { spaceId, chatId } = await channel();
  await send(db, { opId: ulid('op'), chatId, actorId: bob,
                   messageId: ulid('msg'), body: 'before' });
  await leaveSpace(db, spaceId, bob);
  await assert.rejects(() => send(db, {
    opId: ulid('op'), chatId, actorId: bob, messageId: ulid('msg'), body: 'after',
  }), (err: Error) => { assert.ok(err instanceof Forbidden); return true; });
});

// ── deleting ───────────────────────────────────────────────────────────────

test('a delete takes a revision and NO ordinal, and keeps the row', opts, async () => {
  const { chatId } = await channel();
  const messageId = ulid('msg');
  await send(db, { opId: ulid('op'), chatId, actorId: bob, messageId, body: 'oops' });
  await send(db, { opId: ulid('op'), chatId, actorId: bob,
                   messageId: ulid('msg'), body: 'after' });

  const { ack } = await deleteMessage(db, {
    opId: ulid("op"), chatId, actorId: bob, messageId });

  assert.equal(ack.ord, null, 'a delete allocates no ordinal');
  assert.equal(ack.rev, 3);
  assert.deepEqual(await head(db, chatId), { headOrd: 2, headRev: 3 },
    'the two counters have diverged — which is the point of having two');

  const row = await db.selectFrom('messages').select(['ord', 'deleted', 'body'])
    .where('id', '=', messageId).executeTakeFirstOrThrow();
  assert.equal(row.ord, 1, 'the ordinal survives, and the gap it leaves is normal');
  assert.equal(row.deleted, true);
  assert.equal(row.body, '', 'the body is cleared rather than retained');
});

test('an author may delete their own; a plain member may not delete another', opts, async () => {
  const { chatId } = await channel();
  const messageId = ulid('msg');
  await send(db, { opId: ulid('op'), chatId, actorId: me, messageId, body: 'mine' });

  // bob is a member, not a space admin — moderation is an admin power held one
  // level up, at the space.
  await assert.rejects(() => deleteMessage(db, {
    opId: ulid('op'), chatId, actorId: bob, messageId,
  }), (err: Error) => { assert.ok(err instanceof Forbidden); return true; });

  // me is the author, and the space admin besides.
  await deleteMessage(db, { opId: ulid('op'), chatId, actorId: me, messageId });
});

test('a space admin may delete somebody else’s message', opts, async () => {
  const { chatId } = await channel();
  const messageId = ulid('msg');
  await send(db, { opId: ulid('op'), chatId, actorId: bob, messageId, body: 'bobs' });
  const { ack } = await deleteMessage(db, { opId: ulid('op'), chatId, actorId: me, messageId });
  assert.equal(ack.ord, null);
});

test('deleting a message that does not exist is refused, not silently accepted',
  opts, async () => {
  const { chatId } = await channel();
  await assert.rejects(() => deleteMessage(db, {
    opId: ulid('op'), chatId, actorId: me, messageId: ulid('msg'),
  }), (err: Error) => { assert.ok(err instanceof MessageNotFoundError); return true; });
});

test('a delete authorizes against ONE snapshot, not two reads of it', opts, async () => {
  // It used to load grants and placement twice — once for `read`, once for
  // delete_own/delete_any. Two wasted round trips, and two chances to disagree:
  // a membership revoked between them would authorise against grants the second
  // read no longer had. Asserted as a query count, because here the correctness
  // property and the cost property are the same property.
  //
  // Counted through a Kysely plugin rather than by patching the pg pool: it is
  // a typed seam, and it counts the queries this code ISSUES rather than the
  // transaction bookkeeping the driver adds around them.
  const { chatId } = await channel();
  const first = ulid('msg');
  const second = ulid('msg');
  await send(db, { opId: ulid('op'), chatId, actorId: bob, messageId: first, body: 'x' });
  await send(db, { opId: ulid('op'), chatId, actorId: bob, messageId: second, body: 'y' });

  const count = () => {
    let queries = 0;
    const counted = db.withPlugin({
      transformQuery: (args) => { queries += 1; return args.node; },
      transformResult: async (args) => args.result,
    });
    return { counted, queries: () => queries };
  };

  const sending = count();
  await send(sending.counted, {
    opId: ulid('op'), chatId, actorId: bob, messageId: ulid('msg'), body: 'z' });

  const deleting = count();
  await deleteMessage(deleting.counted, {
    opId: ulid('op'), chatId, actorId: bob, messageId: first });

  // Equal, and the arithmetic is worth knowing: a delete pays one extra read to
  // find the message's author, and saves one write by not bumping the space's
  // activity clock — a tombstone is activity for the sync cursor but not a
  // reason to keep a space out of the inactive list. Before the fix it was
  // sending.queries() + 2, from loading grants and placement a second time.
  assert.equal(deleting.queries(), sending.queries(),
    'a delete costs what a send costs — not two authorization reads more');
  // Was 7 before the event log and 8 before the version rule. Each time both
  // sides gained exactly one statement — the append, then the append's bump of
  // the messages the event touches — so the equality above is untouched and
  // this number moved by one. It is here to make a change like that deliberate
  // rather than invisible: an op that starts costing two extra statements
  // should fail a test, not show up as latency later.
  assert.equal(sending.queries(), 9, 'and neither has quietly grown');
});

// ── the event stream ───────────────────────────────────────────────────────

test('one stream carries messages and deletes, in revision order', opts, async () => {
  // The uniformity `rev` exists for: a client asks one question per chat rather
  // than one per kind of change.
  //
  // THE EXPECTATION HERE CHANGED when catch-up moved to the event log, and the
  // change is the reason the log exists. Derived from message rows, this
  // returned TWO events — `[[2,'msg'], [3,'del']]` — because the first
  // message's row had been overwritten by its own deletion, so revision 1 was
  // not recoverable from anywhere. The old assertion recorded that as intended.
  // A client catching up from zero learned of a message only as the deletion of
  // something it had never seen created (docs/SYNC-FLOWS.md §12.1).
  const { chatId } = await channel();
  const first = ulid('msg');
  await send(db, { opId: ulid('op'), chatId, actorId: bob, messageId: first, body: 'one' });
  await send(db, { opId: ulid('op'), chatId, actorId: bob,
                   messageId: ulid('msg'), body: 'two' });
  await deleteMessage(db, { opId: ulid('op'), chatId, actorId: bob, messageId: first });

  const events = await eventsSince(db, chatStream(chatId), 0);
  assert.deepEqual(events.map(e => [e.rev, e.type]),
    [[1, 'message.created'], [2, 'message.created'], [3, 'message.deleted']],
    'every revision is recoverable, including the creation of a message later deleted');
});

// ── §9.3 catch-up below the gap threshold (the spike's numbers) ─────────────

test('SPIKE §9.3: below the threshold the server replays in full', opts, async () => {
  const { chatId } = await channel();
  await fill(chatId, 8);
  const result = await catchup(db, chatStream(chatId), 0, 10);
  assert.equal(result.kind, 'replay');
  if (result.kind !== 'replay') return;
  assert.equal(result.toRev, 8, 'cursor would reach head');
  assert.equal(result.events.length, 8, 'every message replayed');
});

// ── §9.3 gap marker above the threshold ────────────────────────────────────

test('SPIKE §9.3: above the threshold the server returns a bounded gap', opts, async () => {
  // 400 messages, threshold 50. This is what bounds a reconnect to O(chats)
  // rather than O(messages).
  const { chatId } = await channel();
  await fill(chatId, 400);
  const result = await catchup(db, chatStream(chatId), 0, 50);
  assert.equal(result.kind, 'gap', 'a gap, not 400 events');
  if (result.kind !== 'gap') return;
  assert.equal(result.headRev, 400);
  // The snapshot is discriminated by stream kind: a chat's answer to "what do I
  // render while behind" is its newest messages, which is meaningless for the
  // streams that carry none.
  assert.equal(result.snapshot.kind, 'messages');
  if (result.snapshot.kind !== 'messages') return;
  assert.equal(result.snapshot.recent.length, 50, 'the tail is bounded');
  assert.equal(result.snapshot.headOrd, 400, 'head_ord is known despite the gap');
  assert.equal(result.snapshot.recent[0]?.ord, 351, 'the tail starts where the gap ends');
  assert.equal(result.snapshot.recent.at(-1)?.ord, 400,
    'and is oldest-first, ready to render');
});

// ── §9.4 keyset backfill paging ────────────────────────────────────────────

test('SPIKE §9.4: paging terminates, without duplicates or holes', opts, async () => {
  const { chatId } = await channel();
  await fill(chatId, 237);
  const gap = await catchup(db, chatStream(chatId), 0, 50);
  assert.equal(gap.kind, 'gap');
  if (gap.kind !== 'gap') return;

  if (gap.snapshot.kind !== 'messages') return;
  let cursor = gap.snapshot.recent[0]?.ord ?? 0;   // the client's oldest_local_ord
  assert.equal(cursor, 188);
  const seen: number[] = [];
  let pages = 0;
  while (cursor > 1) {
    const rows = await backfill(db, chatId, cursor, 50);
    if (rows.length === 0) break;
    seen.push(...rows.map(r => r.ord));
    cursor = Math.min(...rows.map(r => r.ord));
    pages += 1;
  }

  assert.equal(pages, 4, 'paging terminates');
  assert.equal(seen.length, new Set(seen).size, 'no duplicates across pages');
  assert.equal(cursor, 1, 'backfill reached the beginning');
  // 1..187 below the tail, plus the 50 in the tail, is the whole history.
  assert.equal(seen.length + gap.snapshot.recent.length, 237, 'full history reassembled');
});

test('backfill INCLUDES tombstones, marked, so a page is complete current state',
  opts, async () => {
  // It used to exclude them, against what SYNC-FLOWS.md §14 promised — and the
  // sync model showed why the promise matters: a client that held the message
  // and fell past the gap threshold before the delete never learned of it, and
  // a deleted root's surviving replies were reachable through nothing at all.
  const { chatId } = await channel();
  await fill(chatId, 5);
  const third = await db.selectFrom('messages').select('id')
    .where('chat_id', '=', chatId).where('ord', '=', 3).executeTakeFirstOrThrow();
  await deleteMessage(db, { opId: ulid('op'), chatId, actorId: bob, messageId: third.id });

  const rows = await backfill(db, chatId, 99, 50);
  assert.deepEqual(rows.map(r => r.ord), [5, 4, 3, 2, 1],
    'ordinal 3 is still there — as a tombstone, never renumbered');
  const tombstone = rows.find(r => r.ord === 3);
  assert.deepEqual([tombstone?.deleted, tombstone?.body], [true, ''],
    'marked deleted, body already gone');
  assert.deepEqual(rows.filter(r => r.ord !== 3).map(r => r.deleted), [false, false, false, false]);
});

// ── the version rule, and repair ───────────────────────────────────────────

test('THE VERSION RULE: a reply bumps its parent; a delete bumps its target and parent',
  opts, async () => {
  const { chatId } = await channel();
  const root = ulid('msg');
  const created = await send(db, { opId: ulid('op'), chatId, actorId: bob, messageId: root, body: 'root' });
  const version = async (id: string) => (await db.selectFrom('messages').select('rev')
    .where('id', '=', id).executeTakeFirstOrThrow()).rev;
  assert.equal(await version(root), created.ack.rev, 'a new message is at the version that created it');

  const reply = ulid('msg');
  const replied = await send(db, { opId: ulid('op'), chatId, actorId: me, messageId: reply,
                                   body: 'reply', parentId: root });
  assert.equal(await version(root), replied.ack.rev,
    'the parent moved to the reply\'s revision: its reply count changed');
  assert.equal(replied.event?.type, 'message.created');

  const deleted = await deleteMessage(db, { opId: ulid('op'), chatId, actorId: me, messageId: reply });
  assert.equal(await version(reply), deleted.ack.rev, 'the deleted reply is at the delete\'s revision');
  assert.equal(await version(root), deleted.ack.rev, 'and so is its parent, whose count changed again');
  assert.deepEqual(deleted.event?.payload, { id: reply, parent_id: root },
    'the delete event names the parent, for a client holding it without the reply');

  const [row] = await backfill(db, chatId, 99, 1);
  assert.equal(row?.replyCount, 0, 'the deleted reply is not counted');
});

test('REPAIR returns what changed among the held, as complete rows, paged by (rev, id)',
  opts, async () => {
  // Carol held 1..5 and left at revision 5. While she was away: 3 was edited
  // (simulated as a bump, edits being Phase 4), 2 was deleted, 4 gained a
  // reply, and twenty more messages arrived. Repair since 5, at or below 5,
  // must return exactly 2, 3 and 4 — and nothing she never held.
  const { chatId } = await channel();
  await fill(chatId, 5);
  const idOf = async (ord: number) => (await db.selectFrom('messages').select('id')
    .where('chat_id', '=', chatId).where('ord', '=', ord).executeTakeFirstOrThrow()).id;
  const sinceRev = (await head(db, chatId)).headRev;
  await send(db, { opId: ulid('op'), chatId, actorId: me, messageId: ulid('msg'),
                   body: 'a reply', parentId: await idOf(4) });
  await deleteMessage(db, { opId: ulid('op'), chatId, actorId: bob, messageId: await idOf(2) });
  await fill(chatId, 20);

  const page = await repair(db, chatId, sinceRev, 5, null, 50);
  assert.deepEqual(page.map(r => r.ord).toSorted((a, b) => a - b), [2, 4],
    'exactly the held messages that changed; never the twenty she never held');
  const [second, fourth] = [page.find(r => r.ord === 2), page.find(r => r.ord === 4)];
  assert.deepEqual([second?.deleted, second?.body], [true, ''], 'the tombstone, complete');
  assert.equal(fourth?.replyCount, 1, 'the parent, with its new count');
  assert.ok(page.every(r => r.rev > sinceRev), 'every row is at a version after she left');

  // Paged by (rev, id), one at a time, and the pages reassemble the same set.
  const seen: number[] = [];
  let after: { rev: number; id: string } | null = null;
  for (let round = 0; round < 10; round++) {
    const rows = await repair(db, chatId, sinceRev, 5, after, 1);
    if (rows.length === 0) break;
    seen.push(...rows.map(r => r.ord));
    const last = rows.at(-1) as MessageRow;
    after = { rev: last.rev, id: last.id };
  }
  assert.deepEqual(seen.toSorted((a, b) => a - b), [2, 4], 'keyset paging loses and repeats nothing');

  // A row that changes AGAIN after the cursor passed it is served again: that
  // is what lets a repair converge under live traffic rather than merely end.
  await deleteMessage(db, { opId: ulid('op'), chatId, actorId: bob, messageId: await idOf(4) });
  const again = await repair(db, chatId, sinceRev, 5, after, 50);
  assert.deepEqual(again.map(r => r.ord), [4], 'the re-changed row comes back at its new version');
});

test('the THREAD page returns undeleted replies by ordinal, complete, with a floor',
  opts, async () => {
  const { chatId } = await channel();
  await fill(chatId, 2);
  const root = (await db.selectFrom('messages').select('id')
    .where('chat_id', '=', chatId).where('ord', '=', 1).executeTakeFirstOrThrow()).id;
  const replies: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = ulid('msg');
    replies.push(id);
    await send(db, { opId: ulid('op'), chatId, actorId: me, messageId: id, body: `r${i}`, parentId: root });
  }
  await deleteMessage(db, { opId: ulid('op'), chatId, actorId: me, messageId: replies[1] as string });

  const first = await threadReplies(db, chatId, root, 0, 2);
  assert.deepEqual(first.map(r => r.body), ['r0', 'r2'], 'oldest first, the deleted one skipped');
  const rest = await threadReplies(db, chatId, root, first.at(-1)?.ord ?? 0, 2);
  assert.deepEqual(rest.map(r => r.body), ['r3'], 'and the page after it');
  assert.ok(rest.length < 2, 'a short page is the end');

  const [parent] = await backfill(db, chatId, 2, 1);
  assert.equal(parent?.replyCount, 3, 'the root counts three undeleted replies');
  assert.deepEqual(await backfill(db, chatId, 99, 50).then(rows => rows.map(r => r.ord)), [2, 1],
    'the chat view still excludes replies');
});

// ── §12 unread and mentions, holding nothing ───────────────────────────────

test('SPIKE §12: unread and mentions are correct with zero messages held',
  opts, async () => {
  // The R2 claim. The count is computed entirely server-side, so a client that
  // holds none of these messages still shows the right badge.
  const { chatId } = await channel();
  await fill(chatId, 300);
  await markRead(db, me, chatId, 100);
  // The readable label is not identity; the durable actor target is.
  await send(db, { opId: ulid('op'), chatId, actorId: bob, messageId: ulid('msg'),
                   body: `ping [My old name](actor:${me}) look at this` });
  await send(db, { opId: ulid('op'), chatId, actorId: bob, messageId: ulid('msg'),
                   body: `and [My current name](actor:${me}) again` });
  await send(db, { opId: ulid('op'), chatId, actorId: bob, messageId: ulid('msg'),
                   body: `[Any fallback](actor:${me}) still targets me` });

  const count = await counters(db, chatId, me);
  assert.equal(count.chatUnread, 203);
  assert.equal(count.mentionCount, 3);

  const held = await db.selectFrom('messages').select('id')
    .where('chat_id', '=', chatId).where('author_id', '=', me).execute();
  assert.equal(held.length, 0, 'and `me` wrote none of them');
});

test('your own messages are not unread to you, and a tombstone is unread to nobody',
  opts, async () => {
  // Both exclusions are why the arithmetic fallback headOrd - lastReadOrd can
  // only ever be a sanity check: it can see neither.
  const { chatId } = await channel();
  await send(db, { opId: ulid('op'), chatId, actorId: me,
                   messageId: ulid('msg'), body: 'mine' });
  const doomed = ulid('msg');
  await send(db, { opId: ulid('op'), chatId, actorId: bob, messageId: doomed, body: 'theirs' });
  await send(db, { opId: ulid('op'), chatId, actorId: bob,
                   messageId: ulid('msg'), body: 'also theirs' });

  assert.equal((await counters(db, chatId, me)).chatUnread, 2);
  await deleteMessage(db, { opId: ulid('op'), chatId, actorId: bob, messageId: doomed });
  assert.equal((await counters(db, chatId, me)).chatUnread, 1);

  const { headOrd } = await head(db, chatId);
  assert.equal(headOrd, 3, 'while the arithmetic fallback would still say 3');
});

// ── §4 read state is a MAX-register ────────────────────────────────────────

test('SPIKE §4: a stale device cannot un-read a chat', opts, async () => {
  const { chatId } = await channel();
  await fill(chatId, 10);
  await markRead(db, me, chatId, 9);
  // The phone, asleep for an hour, syncing an older cursor.
  await markRead(db, me, chatId, 5);
  const row = await db.selectFrom('chat_read_state').select('last_read_ord')
    .where('chat_id', '=', chatId).where('actor_id', '=', me).executeTakeFirstOrThrow();
  assert.equal(row.last_read_ord, 9, 'the maximum wins, never the latest');
  assert.equal((await counters(db, chatId, me)).chatUnread, 1);
});

// ── welcome ────────────────────────────────────────────────────────────────

test('welcome carries head and counters for every chat, in one call', opts, async () => {
  const first = await channel();
  const second = await channel();
  await fill(first.chatId, 3);
  await fill(second.chatId, 2);
  await markRead(db, me, first.chatId, 1);

  const { chats: rows } = await welcome(db, wsp, me);
  const byChat = new Map(rows.map(r => [r.chatId, r]));
  assert.equal(byChat.get(first.chatId)?.chatUnread, 2);
  assert.equal(byChat.get(first.chatId)?.headOrd, 3);
  assert.equal(byChat.get(second.chatId)?.chatUnread, 2);
});

test('welcome agrees with counters(), chat for chat, across the awkward cases',
  opts, async () => {
  // The whole claim of the batched query is "same answers, fewer round trips",
  // so the same answers is what gets asserted — against the single-chat
  // function, which is the implementation the spike's numbers were ported onto.
  //
  // The cases chosen are the ones where a batched query typically diverges: a
  // chat with no read-state row at all (the LEFT JOIN), a chat with nothing in
  // it (the lateral must still yield a row), and chats whose counts are zero
  // for two different reasons — everything read, and everything mine.
  const readToEnd = await channel();
  const neverOpened = await channel();
  const onlyMine = await channel();
  const withTombstones = await channel();
  const empty = await channel();

  await fill(readToEnd.chatId, 4);
  await markRead(db, me, readToEnd.chatId, 4);

  await fill(neverOpened.chatId, 3);          // deliberately no markRead: no row
  await send(db, { opId: ulid('op'), chatId: neverOpened.chatId, actorId: bob,
                   messageId: ulid('msg'),
                   body: `hi [first](actor:${me}) and [second](actor:${me}) twice` });

  await fill(onlyMine.chatId, 3, me);

  await fill(withTombstones.chatId, 5);
  const doomed = await db.selectFrom('messages').select('id')
    .where('chat_id', '=', withTombstones.chatId).where('ord', '=', 2)
    .executeTakeFirstOrThrow();
  await deleteMessage(db, { opId: ulid('op'), chatId: withTombstones.chatId,
                            actorId: bob, messageId: doomed.id });

  const batched = new Map((await welcome(db, wsp, me)).chats.map(row => [row.chatId, row]));

  for (const { chatId } of [readToEnd, neverOpened, onlyMine, withTombstones, empty]) {
    const one = await counters(db, chatId, me);
    const many = batched.get(chatId);
    assert.ok(many, `${chatId} missing from welcome`);
    assert.deepEqual(
      { chatUnread: many.chatUnread, mentionCount: many.mentionCount },
      one, `welcome disagreed with counters() for ${chatId}`);
    assert.deepEqual({ headOrd: many.headOrd, headRev: many.headRev },
                     await head(db, chatId));
  }

  // And the values themselves, so "they agree" cannot be two implementations
  // agreeing on the wrong number.
  assert.equal(batched.get(readToEnd.chatId)?.chatUnread, 0, 'read to the end');
  assert.equal(batched.get(neverOpened.chatId)?.chatUnread, 4, 'never opened: all of it');
  assert.equal(batched.get(neverOpened.chatId)?.mentionCount, 1,
    'one message mentioning me, however many times it does so');
  assert.equal(batched.get(onlyMine.chatId)?.chatUnread, 0, 'my own are not unread to me');
  assert.equal(batched.get(withTombstones.chatId)?.chatUnread, 4, 'a tombstone is unread to nobody');
  assert.equal(batched.get(empty.chatId)?.chatUnread, 0, 'and an empty chat still appears');
});

test('welcome costs the SAME whatever the chat count', opts, async () => {
  // The regression this exists for: the first version issued 1 + 2N statements,
  // which is invisible in a test that only checks the values and fatal at the
  // moment every client reconnects at once after a deploy — 301 statements per
  // welcome, times every client in the jitter window.
  //
  // ASSERTED AS A COMPARISON, not as a number. This used to require exactly one
  // statement, which was true and was not the property: the frame legitimately
  // reads four different shapes, and growing to four would have failed a test
  // that was guarding the wrong thing. What must never change is the SLOPE.
  const count = async (): Promise<{ queries: number; chats: number }> => {
    let queries = 0;
    const counted = db.withPlugin({
      transformQuery: (args) => { queries += 1; return args.node; },
      transformResult: async (args) => args.result,
    });
    const payload = await welcome(counted, wsp, me);
    return { queries, chats: payload.chats.length };
  };

  await channel();
  await channel();
  const few = await count();

  for (let i = 0; i < 6; i++) await channel();
  const many = await count();

  assert.ok(many.chats > few.chats + 4, 'the fixture really did grow');
  assert.equal(many.queries, few.queries,
    `welcome went from ${few.queries} queries at ${few.chats} chats `
    + `to ${many.queries} at ${many.chats} — that is a slope, not a constant`);
});

test('welcome shows only chats the actor belongs to', opts, async () => {
  const mine = await channel();
  const { chatId: theirs } = await createChannel(db, {
    workspaceId: wsp, name: 'private-to-bob', createdBy: bob });

  const { chats: rows } = await welcome(db, wsp, me);
  const ids = rows.map(r => r.chatId);
  assert.ok(ids.includes(mine.chatId));
  assert.ok(!ids.includes(theirs), 'a chat in a space `me` never joined is not listed');
});

test('SPIKE §6.6: removal freezes a chat — it leaves welcome, and re-add restores it',
  opts, async () => {
  const { spaceId, chatId } = await channel();
  await fill(chatId, 3);
  assert.ok((await welcome(db, wsp, bob)).chats.some(c => c.chatId === chatId));

  await leaveSpace(db, spaceId, bob);
  assert.ok(!(await welcome(db, wsp, bob)).chats.some(c => c.chatId === chatId),
    'the cursor simply stops advancing — nothing is recalled');

  // Messages arrive while bob is away — from `me`, who is still a member. Bob
  // could not send these even if he tried, which the test above already covers.
  // His local copy stays frozen at what he had.
  await fill(chatId, 2, me);
  await joinSpace(db, spaceId, bob);

  const back = (await welcome(db, wsp, bob)).chats.find(c => c.chatId === chatId);
  assert.equal(back?.headRev, 5, 'and re-adding is exactly a gap: the head moved on');
});

test('the replay limit and the gap threshold cannot drift apart', opts, () => {
  // Two constants that happen to match are two constants that will eventually
  // not. Raise the threshold alone and a replay is silently capped by the read
  // limit — a client told it may replay 900 revisions is sent 500.
  //
  // That is survivable only because `toRev` reports what was DELIVERED rather
  // than the head, so a second round finishes the job. Before that fix it was a
  // silent permanent hole, which is why this is asserted rather than trusted.
  assert.equal(REPLAY_LIMIT, GAP_THRESHOLD,
    'a client that may replay N must be able to receive N');
});
