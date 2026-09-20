// The index into what memory holds (docs/MEMORY.md §8.3).
//
// Hindsight returns metadata with a recalled fact but cannot be ASKED "which
// documents came from message X" — metadata is not a filter there. So the
// mapping lives in Postgres, and one table serves four jobs: forgetting a
// deleted message, dropping a deleted space, moving a converted space's
// documents, and answering how far memory has read without a network call.
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { forget } from './client.ts';

/**
 * The document id we send on retain, and the only handle that forgets it.
 *
 * `<chat_id>:<ord_start>-<ord_end>` rather than a fresh ULID, so it is derivable
 * from the episode alone. A retry that recomputes the same episode produces the
 * same id and REPLACES its document rather than duplicating it — the same
 * reasoning as client-generated message ids (`DESIGN.md` §10.1).
 */
export const documentIdFor = (chatId: string, ordStart: number, ordEnd: number): string =>
  `${chatId}:${ordStart}-${ordEnd}`;

export interface MemoryDocument {
  bankId: string;
  documentId: string;
  workspaceId: string;
  spaceId: string;
  chatId: string;
  ordStart: number;
  ordEnd: number;
  /** The highest `messages.rev` in the range at retain time — the staleness mark (027). */
  sourceRevMax: number;
}

/**
 * Record what is about to be retained.
 *
 * Written BEFORE the retain, and the asymmetry is the reason. A row with no
 * document in Hindsight makes the forget path delete something that was never
 * there, which is a wasted call. A document with no row is invisible to every
 * sweep — it cannot be forgotten when its message is deleted, cannot be moved
 * when its space goes private, and cannot be counted. Invisible is what a leak
 * looks like, so the ordering fails toward the wasted call.
 *
 * Idempotent on `(bank_id, document_id)`, because the id is derived from the
 * episode and a retry recomputes the same one.
 */
export async function recordDocument(db: Kysely<DB>, document: MemoryDocument): Promise<void> {
  await db.insertInto('memory_documents')
    .values({
      bank_id: document.bankId, document_id: document.documentId,
      workspace_id: document.workspaceId, space_id: document.spaceId, chat_id: document.chatId,
      ord_start: document.ordStart, ord_end: document.ordEnd,
      source_rev_max: document.sourceRevMax,
    })
    .onConflict((conflict) => conflict.columns(['bank_id', 'document_id']).doUpdateSet({
      ord_start: document.ordStart, ord_end: document.ordEnd,
      source_rev_max: document.sourceRevMax,
    }))
    .execute();
}

/**
 * Every document whose episode contains this message.
 *
 * The forget path's only question. A deleted message arrives as (chat, ord) and
 * this turns it into the documents that have to go — normally one, but the type
 * is a list because a re-ingest that widened an episode can leave two covering
 * the same ordinal, and silently forgetting only the first would leave the fact
 * recallable from the second.
 */
export async function documentsCovering(
  db: Kysely<DB>, chatId: string, ord: number,
): Promise<MemoryDocument[]> {
  const rows = await db.selectFrom('memory_documents').selectAll()
    .where('chat_id', '=', chatId)
    .where('ord_start', '<=', ord)
    .where('ord_end', '>=', ord)
    .execute();
  return rows.map(fromRow);
}

/** Every document derived from a space — a deletion or a visibility change. */
export async function documentsForSpace(db: Kysely<DB>, spaceId: string): Promise<MemoryDocument[]> {
  const rows = await db.selectFrom('memory_documents').selectAll()
    .where('space_id', '=', spaceId)
    .orderBy('retained_at')
    .execute();
  return rows.map(fromRow);
}

/**
 * Forget a document: Hindsight first, then the row.
 *
 * THAT ORDER, and it is the opposite of the write path's. Dropping the row
 * first would leave a document nothing can find, so the facts would stay
 * recallable with no record that they exist. A failed Hindsight delete
 * therefore keeps the row, and the sweep tries again on the next tick —
 * forgetting is retried until it happens rather than declared done once.
 */
export async function forgetDocument(db: Kysely<DB>, document: MemoryDocument): Promise<void> {
  await forget(document.bankId, document.documentId);
  await db.deleteFrom('memory_documents')
    .where('bank_id', '=', document.bankId)
    .where('document_id', '=', document.documentId)
    .execute();
}

interface Row {
  bank_id: string; document_id: string; workspace_id: string;
  space_id: string; chat_id: string; ord_start: number; ord_end: number;
  source_rev_max: number;
}

const fromRow = (row: Row): MemoryDocument => ({
  bankId: row.bank_id, documentId: row.document_id, workspaceId: row.workspace_id,
  spaceId: row.space_id, chatId: row.chat_id, ordStart: row.ord_start, ordEnd: row.ord_end,
  sourceRevMax: row.source_rev_max,
});
