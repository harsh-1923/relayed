// The write path: what a client does with an op it cannot send yet.
// Step 11 of the sync build plan (docs/SYNC-FLOWS.md §2, §17).
//
// COALESCING RUNS ON ENQUEUE, and it is a correctness requirement rather than
// an optimisation. The bug it prevents: somebody composes a message offline and
// then deletes it. Queue both naively and the `delete` targets a message id the
// server has never seen — best case it 404s and both ops land in `failed`,
// worst case they arrive out of order and there is a ghost message nobody can
// remove. Dropping the pair means ZERO network operations, not two that fail.
//
// That is also why the outbox indexes `target_id`: coalescing looks ops up by
// what they act on, on every single enqueue.
//
// THE ROW AND ITS ECHO ARE ONE TRANSACTION (invariant 40). A crash between the
// optimistic message and the outbox entry leaves a message that looks sent and
// never will be — which is indistinguishable, to the person who wrote it, from
// the message having been delivered.
import type { DatabaseSync } from 'node:sqlite';

export type OpKind = 'send' | 'delete';

export interface Op {
  opId: string;
  kind: OpKind;
  chatId: string;
  /** The message this acts on. `send` creates it; `delete` names it. */
  targetId: string;
  payload: Record<string, unknown>;
}

export interface QueuedOp extends Op {
  seq: number;
  attempts: number;
}

/** What enqueuing did. `coalesced` means the wire never hears about it. */
export type Enqueued =
  | { outcome: 'queued'; seq: number }
  | { outcome: 'coalesced'; dropped: string[] };

/**
 * Queue an op, collapsing it against what is already waiting.
 *
 * THE TABLE, and only the rows this phase can produce. `send` + `edit` and the
 * reaction pairs wait for Phase 4 along with the ops themselves — carrying them
 * now would be branches nothing exercises, which is how a coalescing rule ends
 * up wrong the first time it runs:
 *
 *   queued   new op    result
 *   send  +  delete  → DROP BOTH. Never touches the network.
 *   —        send    → queue it
 *   —        delete  → queue it
 *
 * Takes the whole enqueue in one transaction with the caller's own write, via
 * `withEcho`. Splitting them is the crash window invariant 40 exists to close.
 */
export function enqueue(
  db: DatabaseSync, op: Op, withEcho?: (db: DatabaseSync) => void,
): Enqueued {
  db.exec('BEGIN');
  try {
    const waiting = db.prepare(
      'SELECT op_id, kind FROM outbox WHERE target_id = ? ORDER BY seq',
    ).all(op.targetId) as { op_id: string; kind: string }[];

    const pendingSend = waiting.find(row => row.kind === 'send');

    if (op.kind === 'delete' && pendingSend) {
      // BOTH, not just the send. The delete is meaningless without it — the
      // server has never heard of this message — and leaving it queued would
      // send a tombstone for something that does not exist.
      const dropped = waiting.map(row => row.op_id);
      db.prepare('DELETE FROM outbox WHERE target_id = ?').run(op.targetId);
      // The optimistic row goes too. It was never sent, so there is nothing to
      // tombstone: keeping it would render a deleted message that no other
      // device has ever seen.
      db.prepare('DELETE FROM messages WHERE id = ? AND state = ?')
        .run(op.targetId, 'pending');
      withEcho?.(db);
      db.exec('COMMIT');
      return { outcome: 'coalesced', dropped };
    }

    const seq = nextSeq(db);
    db.prepare(`
      INSERT INTO outbox (op_id, seq, kind, chat_id, target_id, payload,
                          created_at, attempts, next_at, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'queued')
    `).run(op.opId, seq, op.kind, op.chatId, op.targetId,
           JSON.stringify(op.payload), Date.now());

    withEcho?.(db);
    db.exec('COMMIT');
    return { outcome: 'queued', seq };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * The ops ready to go, in order, at most one per chat.
 *
 * IN ORDER PER CHAT, ONE IN FLIGHT — otherwise three messages typed offline
 * arrive shuffled, which is the thing a person notices immediately and cannot
 * explain. Across chats there is no ordering to preserve, so they go in
 * parallel: a chat blocked on a slow op must not hold up every other one.
 */
export function ready(db: DatabaseSync, now = Date.now()): QueuedOp[] {
  const rows = db.prepare(`
    SELECT op_id, seq, kind, chat_id, target_id, payload, attempts
      FROM outbox
     WHERE state = 'queued' AND next_at <= ?
     ORDER BY seq
  `).all(now) as {
    op_id: string; seq: number; kind: string; chat_id: string;
    target_id: string; payload: string; attempts: number;
  }[];

  const claimed = new Set<string>();
  const out: QueuedOp[] = [];
  for (const row of rows) {
    // The first ready op per chat, and no more. `seq` order means that is also
    // the oldest, which is what "in the order typed" means.
    if (claimed.has(row.chat_id)) continue;
    claimed.add(row.chat_id);
    out.push({
      opId: row.op_id, seq: row.seq, kind: row.kind as OpKind,
      chatId: row.chat_id, targetId: row.target_id,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      attempts: row.attempts,
    });
  }
  return out;
}

/** Mark an op as sent, so it is not sent twice while a reply is outstanding. */
export function markInflight(db: DatabaseSync, opId: string): void {
  db.prepare("UPDATE outbox SET state = 'inflight' WHERE op_id = ? AND state = 'queued'")
    .run(opId);
}

/** What a refusal did, and which surfaces need redrawing because of it. */
export interface NackResult {
  outcome: 'retrying' | 'failed';
  topics: string[];
}

export interface Ack {
  messageId: string;
  chatId: string;
  ord: number | null;
  rev: number;
  createdAt: string;
}

/**
 * The server confirmed it: stamp the row and clear the queue entry, together.
 *
 * ONE TRANSACTION, and the pairing is the point. Clear the outbox first and a
 * crash loses the ack — the message stays `pending` for ever with nothing left
 * to retry. Stamp first and a crash re-sends an op the server has already
 * applied, which is survivable (the idempotency ledger returns the same ack)
 * but writes a duplicate outbox attempt for no reason.
 */
export function applyAck(db: DatabaseSync, opId: string, ack: Ack): string[] {
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE messages SET ord = ?, rev = ?, created_at = ?, state = 'acked'
       WHERE id = ?
    `).run(ack.ord, ack.rev, Date.parse(ack.createdAt), ack.messageId);

    db.prepare(`
      INSERT INTO chat_state (chat_id, head_ord) VALUES (?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        head_ord = MAX(chat_state.head_ord, excluded.head_ord)
    `).run(ack.chatId, ack.ord ?? 0);

    db.prepare('DELETE FROM outbox WHERE op_id = ?').run(opId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return [`chat:${ack.chatId}:messages`, `chat:${ack.chatId}:state`];
}

/** Backoff for attempt N, with full jitter. Same curve as the connection's. */
export function retryAt(
  attempts: number, now = Date.now(), random: () => number = Math.random,
): number {
  const ceiling = Math.min(1_000 * 2 ** attempts, 60_000);
  return now + random() * ceiling;
}

/**
 * The server refused it.
 *
 * `retryable` decides between backoff and a terminal failure, and the
 * distinction is not cosmetic. A send into a chat somebody was removed from will
 * NEVER succeed — retrying it silently for ever is worse than an error, because
 * the person sees a message that looks queued and never learns it will not go.
 * A terminal failure is surfaced with retry and discard, which are the only two
 * things anyone can actually do about it.
 */
export function applyNack(
  db: DatabaseSync, opId: string, retryable: boolean, error: string,
  now = Date.now(), random: () => number = Math.random,
): NackResult {
  const row = db.prepare('SELECT attempts, target_id, chat_id FROM outbox WHERE op_id = ?')
    .get(opId) as { attempts: number; target_id: string; chat_id: string } | undefined;
  // An op that is no longer here settled some other way — an ack that raced it,
  // or a discard. Nothing to do, and nothing to wake.
  if (!row) return { outcome: 'failed', topics: [] };

  if (retryable) {
    db.prepare(`UPDATE outbox SET state = 'queued', attempts = attempts + 1,
                next_at = ?, error = ? WHERE op_id = ?`)
      .run(retryAt(row.attempts, now, random), error, opId);
    // Nothing rendered changes: the message is still pending and still going to
    // be sent. Waking a surface to redraw an identical row is noise.
    return { outcome: 'retrying', topics: [] };
  }

  db.exec('BEGIN');
  try {
    db.prepare("UPDATE outbox SET state = 'failed', error = ? WHERE op_id = ?")
      .run(error, opId);
    // The optimistic row is marked too, so the surface can show WHICH message
    // failed rather than a banner about an op id nobody has seen.
    db.prepare("UPDATE messages SET state = 'failed' WHERE id = ? AND state = 'pending'")
      .run(row.target_id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  // The CHAT, read from the row rather than guessed. An earlier version
  // invalidated `chat:<error code>:messages`, which woke nothing and would have
  // left a failed message rendering as pending until something else happened to
  // refresh it.
  return {
    outcome: 'failed',
    topics: [`chat:${row.chat_id}:messages`, `chat:${row.chat_id}:state`],
  };
}

/** Everything a person could act on: failed ops, newest first. */
export function failed(db: DatabaseSync): (QueuedOp & { error: string | null })[] {
  const rows = db.prepare(`
    SELECT op_id, seq, kind, chat_id, target_id, payload, attempts, error
      FROM outbox WHERE state = 'failed' ORDER BY seq DESC
  `).all() as {
    op_id: string; seq: number; kind: string; chat_id: string;
    target_id: string; payload: string; attempts: number; error: string | null;
  }[];
  return rows.map(row => ({
    opId: row.op_id, seq: row.seq, kind: row.kind as OpKind,
    chatId: row.chat_id, targetId: row.target_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    attempts: row.attempts, error: row.error,
  }));
}

/**
 * Try a failed op again, at the back of the queue.
 *
 * At the back rather than in place: its original `seq` is long past, and
 * re-inserting there would put it ahead of everything typed since — so a
 * message from an hour ago would appear before this morning's.
 */
export function retry(db: DatabaseSync, opId: string): void {
  db.prepare(`UPDATE outbox SET state = 'queued', next_at = 0, error = NULL, seq = ?
               WHERE op_id = ? AND state = 'failed'`).run(nextSeq(db), opId);
  db.prepare(`UPDATE messages SET state = 'pending'
               WHERE id = (SELECT target_id FROM outbox WHERE op_id = ?)`).run(opId);
}

/** Give up on it, and remove the message it was going to send. */
export function discard(db: DatabaseSync, opId: string): void {
  db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT target_id, kind FROM outbox WHERE op_id = ?')
      .get(opId) as { target_id: string; kind: string } | undefined;
    db.prepare('DELETE FROM outbox WHERE op_id = ?').run(opId);
    // Only a `send`'s echo is removed. Discarding a failed DELETE must leave
    // the message alone — the person wanted it gone and could not have it, and
    // deleting it locally would be the app doing the thing the server refused.
    if (row?.kind === 'send') {
      db.prepare("DELETE FROM messages WHERE id = ? AND state IN ('pending','failed')")
        .run(row.target_id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** How many ops are waiting. A metric, and what "drain finished" means. */
export function depth(db: DatabaseSync): { queued: number; failed: number } {
  const row = db.prepare(`
    SELECT SUM(state != 'failed') AS queued, SUM(state = 'failed') AS failed
      FROM outbox
  `).get() as { queued: number | null; failed: number | null };
  return { queued: row.queued ?? 0, failed: row.failed ?? 0 };
}

/**
 * The next local sequence number.
 *
 * Derived from the table rather than held in memory, because the outbox
 * outlives the process: a counter reset on restart would hand a new op a
 * sequence below one already queued, and it would drain out of order.
 */
function nextSeq(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS top FROM outbox').get() as
    { top: number };
  return row.top + 1;
}
