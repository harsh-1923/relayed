// Ordinal and revision allocation, and the idempotency ledger around it.
// Allocation and idempotency — step 2 of the sync build plan
// (docs/SYNC-FLOWS.md §2), the same work PHASE-2-SYNC.md §3 letters as step B.
//
// Twenty lines, and the most dangerous twenty in the phase: every guarantee the
// sync core makes about ORDER rests on them, and both failure modes here are
// silent. A lost update hands two messages the same ordinal, which corrupts
// read cursors on every client that already saw the first. A missing
// idempotency check turns one lost ack into two messages, which is the single
// most common offline-sync bug there is.
//
// No transport, no access checks, no product meaning. The domain ops — `send`,
// `delete` and the space operations — compose these and add the membership
// check; this file only knows how to hand out numbers exactly once.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/schema.ts';
import {
  chatStream, streamName,
  type ChatAllocation, type SpaceStream, type StreamAllocation, type WorkspaceStream,
} from './events.ts';

/**
 * Take the next ordinal and revision for a chat.
 *
 * Takes a `Transaction`, not a `Kysely`, and the type is doing real work: the
 * allocation MUST commit or roll back with the row it numbers. Allocate in one
 * transaction and insert in another and a crash between them burns an ordinal —
 * `head_ord` then names a message that does not exist, and every client's
 * unread arithmetic is permanently one too high.
 *
 * The `SET x = x + 1` form is what makes this safe under concurrency, and it is
 * not interchangeable with reading the counter and writing it back. The UPDATE
 * takes a row lock; a second transaction attempting the same chat blocks, and
 * when it resumes it re-reads the committed value and adds to THAT. Read-then-
 * write instead and two senders both read 4 and both write 5 — asserted in the
 * tests, both directions.
 *
 * `ord` is null for a mutation that is not a new message — a delete, and in
 * Phase 4 an edit or a reaction. That is the two-counter model in a type: only
 * a new message takes an ordinal, while EVERY mutation takes a revision
 * (DESIGN.md §8.1). A caller that reaches for `ord` on a delete has to handle
 * the null, which is the point.
 *
 * The workspace comes back from this same statement rather than from a second
 * read, so an event written against this allocation cannot be filed under the
 * wrong tenant (`events.ts`, on `StreamAllocation`).
 */
export async function allocateChat(
  trx: Transaction<DB>, chatId: string, withOrd: boolean,
): Promise<ChatAllocation> {
  const row = await trx.updateTable('chats')
    .set({
      next_rev: sql<number>`next_rev + 1`,
      // Parameterised rather than branched into two statements, so a mutation
      // and a message take the same single lock on the same row.
      next_ord: sql<number>`next_ord + ${withOrd ? 1 : 0}`,
    })
    .where('id', '=', chatId)
    // `updated_at` is deliberately untouched: on a chat it is the LWW clock for
    // the chat's own attributes (its name), not a last-activity marker. Bumping
    // it here would make every message look like a rename.
    .returning(['next_ord', 'next_rev', 'workspace_id'])
    .executeTakeFirst();

  // No row means no such chat. Thrown rather than returned, because a caller
  // that got here has already decided this chat exists — the domain ops check
  // membership first, and membership implies the chat. Returning undefined
  // would let `ord` reach an INSERT as undefined.
  if (!row) throw new UnknownChatError(chatId);

  return {
    stream: chatStream(chatId),
    ord: withOrd ? row.next_ord : null,
    rev: row.next_rev,
    workspaceId: row.workspace_id,
  };
}

/**
 * Take the next revision for a stream that has no ordinal — a space, or the
 * workspace directory.
 *
 * A SEPARATE function rather than a `kind` parameter on `allocateChat`, for the
 * same reason `spaces.ts` has `createChannel` instead of `createSpace(kind, …)`:
 * only a chat has an ordinal, so a single entry point would have to accept a
 * parameter that is meaningless for two of its three arguments, or return a
 * field that is always null. Two functions ARE that discriminated union, and
 * `allocateStream` has no `withOrd` to misuse.
 *
 * What is deliberately NOT different is the SQL. Both use the same
 * `SET next_rev = next_rev + 1 … RETURNING`, and the temptation to give a space
 * a read-then-write counter because spaces are low-traffic must be resisted: a
 * lost update is a lost update at any rate, and on a revision it silently
 * REUSES one — two different events claiming the same position in a cursor,
 * which is worse than losing a position.
 */
export async function allocateStream<S extends SpaceStream | WorkspaceStream>(
  // Generic over the stream rather than taking the union, so the narrowing
  // survives the call. Returning the wide `Stream` would hand `appendEvent` a
  // value that might be a chat, and the catalogue's whole job is to reject a
  // space event aimed at a chat stream.
  trx: Transaction<DB>, stream: S,
): Promise<StreamAllocation & { stream: S }> {
  if (stream.kind === 'space') {
    const row = await trx.updateTable('spaces')
      .set({ next_rev: sql<number>`next_rev + 1` })
      .where('id', '=', stream.id)
      .returning(['next_rev', 'workspace_id'])
      .executeTakeFirst();
    if (!row) throw new UnknownStreamError(stream);
    return { stream, rev: row.next_rev, workspaceId: row.workspace_id };
  }

  const row = await trx.updateTable('workspaces')
    .set({ next_rev: sql<number>`next_rev + 1` })
    .where('id', '=', stream.id)
    // A workspace IS its own workspace. Returned explicitly rather than reusing
    // `stream.id`, so the value in the event comes from the committed row like
    // every other allocation's does.
    .returning(['next_rev', 'id'])
    .executeTakeFirst();
  if (!row) throw new UnknownStreamError(stream);
  return { stream, rev: row.next_rev, workspaceId: row.id };
}

export class UnknownChatError extends Error {
  readonly chatId: string;
  constructor(chatId: string) {
    super(`no chat ${chatId}`);
    this.name = 'UnknownChatError';
    this.chatId = chatId;
  }
}

/** No such space or workspace. The non-chat sibling of `UnknownChatError`. */
export class UnknownStreamError extends Error {
  readonly stream: SpaceStream | WorkspaceStream;
  constructor(stream: SpaceStream | WorkspaceStream) {
    super(`no stream ${streamName(stream)}`);
    this.name = 'UnknownStreamError';
    this.stream = stream;
  }
}

/** An op_id presented by an actor other than the one that first used it. */
export class OpOwnershipError extends Error {
  readonly opId: string;
  constructor(opId: string) {
    super(`op ${opId} belongs to a different actor`);
    this.name = 'OpOwnershipError';
    this.opId = opId;
  }
}

/** Who is doing what, and where — the ledger's half of an op. */
export interface OpClaim {
  opId: string;
  actorId: string;
  chatId: string;
  kind: 'send' | 'delete';
}

export interface Applied<T> {
  /** True when the ledger answered and `work` never ran. */
  replayed: boolean;
  result: T;
}

/** Postgres raises 23505 for a unique or primary-key violation. */
const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null
  && (err as { code?: string }).code === UNIQUE_VIOLATION;

/**
 * Run `work` exactly once for a given op id, in one transaction with the ledger
 * entry that records it.
 *
 * A retried op must return the SAME ack, not do the work again. Without this, a
 * client that sends, loses the connection before the ack arrives, and retries
 * produces a duplicate message — and the duplicate is indistinguishable from a
 * user sending twice, so nobody reports it as a bug (DESIGN.md §8.4).
 *
 * The stored ack is returned verbatim rather than recomputed, which is the part
 * that matters: recomputing would allocate a second ordinal and hand back a
 * different one from the ordinal already delivered to somebody.
 *
 * ONE RETRY, and one is provably enough. Two concurrent copies of the same op
 * both pass the ledger read and both do the work; the loser blocks on a unique
 * index and Postgres raises the violation only when the winner COMMITS. If the
 * winner rolls back instead, the loser simply proceeds. So a violation here
 * means the winning row is committed and visible to a fresh transaction, and
 * the retry's ledger read therefore finds it. A loop would be theatre.
 *
 * ANY unique violation is retried, not only one on the ledger — and working out
 * why took tracing the statement order rather than reasoning about it. `work`
 * runs BEFORE the ledger insert, so two concurrent sends collide on
 * `messages_pkey` first and never reach `ops_pkey` at all. Retrying only on the
 * ledger's constraint would have left the most ordinary case — a client
 * retrying a send whose ack was lost — throwing a raw database error.
 *
 * Retrying broadly is safe because the retry is justified by EVIDENCE rather
 * than by a guess: the second attempt re-reads the ledger, and only returns a
 * replay if the op is actually there. A unique violation from something else —
 * two different ops claiming one message id — finds no ledger row, runs `work`
 * again, fails the same way, and surfaces. Which is what a client bug should do.
 */
export async function applyOnce<T>(
  db: Kysely<DB>,
  claim: OpClaim,
  work: (trx: Transaction<DB>) => Promise<T>,
): Promise<Applied<T>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db.transaction().execute(async (trx) => {
        const prior = await trx.selectFrom('ops')
          .select(['actor_id', 'result'])
          .where('op_id', '=', claim.opId)
          .executeTakeFirst();

        if (prior) {
          // op_id is chosen by a client, so a second actor presenting someone
          // else's is either a collision or an attempt to be handed an ack
          // naming a message they may not be allowed to see.
          if (prior.actor_id !== claim.actorId) throw new OpOwnershipError(claim.opId);
          return { replayed: true, result: prior.result as T };
        }

        const result = await work(trx);
        await trx.insertInto('ops').values({
          op_id: claim.opId, actor_id: claim.actorId, chat_id: claim.chatId,
          kind: claim.kind, result: JSON.stringify(result),
        }).execute();
        return { replayed: false, result };
      });
    } catch (err) {
      if (attempt === 0 && isUniqueViolation(err)) continue;
      throw err;
    }
  }
  // Unreachable: the loop either returns or throws. Present because the
  // compiler cannot see that, and an implicit undefined here would be an
  // allocation that silently returned nothing.
  throw new Error(`applyOnce exhausted its retry for op ${claim.opId}`);
}
