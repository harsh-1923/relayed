// The write path's domain layer: send, delete, and marking a chat read.
// Phase 2 step C (PHASE-2-SYNC.md §3).
//
// Plain functions over the database, callable without a socket in sight. Step D
// puts frames in front of them; nothing here knows a socket exists, which is
// what lets every rule below be tested without one.
//
// Shapes are camelCase and domain-shaped, not wire-shaped. The wire format is
// settled in step D and mapped there — keeping the two apart means the ledger
// stores a result the transport can reshape, rather than pinning the protocol
// to whatever this file happened to return first.
import { sql, type Kysely } from 'kysely';
import { can, chat as chatTarget } from '@relayed/authz';
import type { DB } from '../db/schema.ts';
import { loadGrants, Forbidden } from '../authz/can.ts';
import { chatPlacement } from './placement.ts';
import { allocateChat, applyOnce } from './allocate.ts';
import { appendEvent } from './events.ts';

/** The message named by an op does not exist. */
export class MessageNotFoundError extends Error {
  readonly messageId: string;
  constructor(messageId: string) {
    super(`no message ${messageId}`);
    this.name = 'MessageNotFoundError';
    this.messageId = messageId;
  }
}

/**
 * What the server tells the sender happened.
 *
 * `ord` is null for a delete, and that is the two-counter model reaching the
 * caller: a delete takes a revision and no ordinal, so the message does not
 * move and nothing else is renumbered (DESIGN.md §8.1).
 */
export interface Ack {
  messageId: string;
  chatId: string;
  ord: number | null;
  rev: number;
  /** Server time, which wins. The client's optimistic value is overwritten. */
  createdAt: string;
}

export interface SendInput {
  opId: string;
  chatId: string;
  actorId: string;
  /** Client-generated ULID, chosen before any network contact (§10.1). */
  messageId: string;
  body: string;
  parentId?: string | null;
}

/**
 * Append a message.
 *
 * Deliberately takes no client timestamp. Client clocks are skewed, adjusted
 * mid-session and occasionally years wrong, so anything cross-device is stamped
 * here (DESIGN.md §13.7). The client's own clock renders its pending row and is
 * replaced by the value in this ack.
 */
export async function send(db: Kysely<DB>, input: SendInput): Promise<Ack> {
  const authorize = await chatGate(db, input.actorId, input.chatId);
  authorize('post');

  const applied = await applyOnce(db, {
    opId: input.opId, actorId: input.actorId, chatId: input.chatId, kind: 'send',
  }, async (trx) => {
    const allocated = await allocateChat(trx, input.chatId, true);
    const row = await trx.insertInto('messages').values({
      id: input.messageId, chat_id: input.chatId, parent_id: input.parentId ?? null,
      ord: allocated.ord as number, rev: allocated.rev,
      author_id: input.actorId, body: input.body,
    }).returning('created_at').executeTakeFirstOrThrow();

    // The space's activity clock, which drives auto-dormancy. Bumped here and
    // not in the allocator, because a delete is activity for the sync cursor
    // but not a reason to keep a space out of the "inactive" list.
    await trx.updateTable('spaces')
      .set({ last_activity_at: sql`now()` })
      .where('id', 'in', eb => eb.selectFrom('chats').select('space_id')
        .where('id', '=', input.chatId))
      .execute();

    const ack = ackOf(input.messageId, input.chatId,
                      allocated.ord, allocated.rev, row.created_at);

    // The event carries the ack's OWN timestamp, not a second reading of the
    // clock. The sender applies the ack and every other device applies the
    // event; if the two disagreed, one message would render at two different
    // times depending on which device you looked at.
    await appendEvent(trx, allocated, 'message.created', {
      id: ack.messageId,
      ord: allocated.ord as number,
      parent_id: input.parentId ?? null,
      author_id: input.actorId,
      body: input.body,
      created_at: ack.createdAt,
    });

    return ack;
  });
  return applied.result;
}

export interface DeleteInput {
  opId: string;
  chatId: string;
  actorId: string;
  messageId: string;
}

/**
 * Tombstone a message.
 *
 * The row stays and keeps its ordinal; only the body is cleared. A gap in the
 * ordinal sequence is normal and permanent — `ord` is never renumbered or
 * reused, or read cursors and scroll positions corrupt across every client that
 * already saw the original.
 *
 * Deleting an already-deleted message still allocates a revision rather than
 * short-circuiting. Two people deleting the same message is not an error, the
 * event is idempotent where it lands, and the special case would earn nothing
 * but a branch.
 */
export async function deleteMessage(db: Kysely<DB>, input: DeleteInput): Promise<Ack> {
  // ONE snapshot of grants and placement, asked TWO questions. Loading twice
  // was two wasted round trips and, worse, two chances to disagree: a
  // membership revoked between the reads would have let the first check pass
  // against grants the second no longer had. can() is pure, so a second
  // question against the same snapshot costs nothing.
  const authorize = await chatGate(db, input.actorId, input.chatId);

  // Chat access FIRST, before the message is read. Reading it to discover its
  // author would tell a non-member whether the message exists.
  authorize('read');

  const message = await db.selectFrom('messages')
    .select(['id', 'chat_id', 'author_id'])
    .where('id', '=', input.messageId)
    .executeTakeFirst();
  if (!message || message.chat_id !== input.chatId) {
    throw new MessageNotFoundError(input.messageId);
  }

  // Deleting your own needs membership; deleting somebody else's is moderation,
  // and moderation is an admin power held at the SPACE rather than at the chat.
  // Both questions go to can(), which is where that distinction is written down.
  authorize(message.author_id === input.actorId ? 'delete_own' : 'delete_any');

  const applied = await applyOnce(db, {
    opId: input.opId, actorId: input.actorId, chatId: input.chatId, kind: 'delete',
  }, async (trx) => {
    const allocated = await allocateChat(trx, input.chatId, false);
    const row = await trx.updateTable('messages')
      .set({ deleted: true, body: '', rev: allocated.rev })
      .where('id', '=', input.messageId)
      .returning('created_at')
      .executeTakeFirstOrThrow();

    // The id alone. A recipient that never held this message writes nothing at
    // all and merely accounts for the revision — which is the case that forces
    // the frontier to be tracked explicitly rather than derived from rows, and
    // the reason `delete` is in this phase at all (PHASE-2-SYNC.md §1).
    await appendEvent(trx, allocated, 'message.deleted', { id: input.messageId });

    return ackOf(input.messageId, input.chatId, null, allocated.rev, row.created_at);
  });
  return applied.result;
}

/**
 * Advance an actor's read cursor.
 *
 * A MAX-register, applied as `GREATEST`, never a blind overwrite (DESIGN.md §4).
 * The failure that prevents: someone reads on their laptop, then their phone —
 * asleep for an hour with stale state — reconnects and syncs. Under
 * last-write-wins the phone's older value wins and the chat goes unread again.
 *
 * No ledger entry and no revision. Read state is not part of the log: it is
 * per-actor, it converges by taking a maximum, and replaying the same value is
 * already a no-op — so idempotency here is a property of the operation rather
 * than something a ledger has to provide.
 */
export async function markRead(
  db: Kysely<DB>, actorId: string, chatId: string, ord: number,
): Promise<void> {
  (await chatGate(db, actorId, chatId))('read');
  await db.insertInto('chat_read_state')
    .values({ chat_id: chatId, actor_id: actorId, last_read_ord: ord })
    .onConflict(oc => oc.columns(['chat_id', 'actor_id']).doUpdateSet({
      // GREATEST, not SQLite's MAX(a,b) — the same register, a different
      // engine's spelling of it.
      last_read_ord: sql`GREATEST(chat_read_state.last_read_ord, EXCLUDED.last_read_ord)`,
      updated_at: sql`now()`,
    }))
    .execute();
}

/**
 * Read an actor's grants and a chat's placement once, and return something that
 * can be asked as many questions as an operation needs.
 *
 * Two round trips, whatever follows. `can()` is pure by design — grants and
 * placement in, boolean out — so every question after the first is free, and
 * every question is answered against the SAME snapshot. That second property is
 * the one that matters: an operation asking twice and loading twice could see a
 * membership change between the two and authorise a state that never existed.
 */
async function chatGate(
  db: Kysely<DB>, actorId: string, chatId: string,
): Promise<(action: string) => void> {
  const [grants, placement] = await Promise.all([
    loadGrants(db, actorId), chatPlacement(db, chatId),
  ]);
  return (action: string): void => {
    if (!can(grants, action, chatTarget(chatId), placement)) {
      throw new Forbidden(action, chatTarget(chatId));
    }
  };
}

const ackOf = (
  messageId: string, chatId: string, ord: number | null, rev: number, createdAt: unknown,
): Ack => ({
  messageId, chatId, ord, rev,
  // Normalised to an ISO string here rather than left as a Date, because this
  // value is stored in the ledger as JSON and replayed verbatim — a Date would
  // come back as a string on the replay and differ from the original ack.
  createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
});
