// Forgetting what changed under us (docs/MEMORY.md §8.1).
//
// A separate file from `documents.ts` — which the plan put this in — because
// rebuilding is not an index operation: it reads messages, builds a transcript
// and retains, which is ingestion's job. `documents.ts` stays the accessors.
//
// WHY A SWEEP AND NOT A HOOK ON DELETE. A hook would put a blocking HTTP call
// inside the write transaction that deletes a message, so Hindsight being slow
// would make deleting a message slow, and Hindsight being down would make it
// fail. Memory is additive; the write path must not learn to depend on it. The
// cost is that forgetting is EVENTUALLY consistent, bounded by the tick — a
// decision, not an accident (§19 asks whether it is the right one).
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { visibleTo } from '../sync/visibility.ts';
import { buildEpisodeText } from './episode.ts';
import { forget, retain } from './client.ts';
import { recordDocument, type MemoryDocument } from './documents.ts';

/** Documents rebuilt in one pass. The rest wait, rather than a long serial burn. */
const BATCH = 20;

export interface StaleDocument extends MemoryDocument {
  spaceName: string | null;
  writerActorId: string;
  /** The highest revision now in the range — what `source_rev_max` becomes after a rebuild. */
  currentRevMax: number;
}

/**
 * Documents whose messages have changed since they were retained.
 *
 * `max(rev) > source_rev_max` is the whole test. It is true after a delete, an
 * edit, or an audience narrowing, and false again once rebuilt — which is what
 * makes the sweep converge instead of rebuilding the same document forever
 * (027).
 *
 * The writer comes back with the row because the rebuild has to read the
 * messages AS THE WRITER: a message restricted away from Roomkeeping must not
 * reappear just because this is a rebuild rather than an ingest.
 */
export async function staleDocuments(db: Kysely<DB>, limit = BATCH): Promise<StaleDocument[]> {
  const rows = await sql<{
    bank_id: string; document_id: string; workspace_id: string; space_id: string;
    chat_id: string; ord_start: number; ord_end: number; source_rev_max: number;
    space_name: string | null; writer_actor_id: string; current_rev_max: number;
  }>`
    SELECT d.bank_id, d.document_id, d.workspace_id, d.space_id, d.chat_id,
           d.ord_start, d.ord_end, d.source_rev_max,
           s.name AS space_name, keeper.id AS writer_actor_id,
           MAX(m.rev) AS current_rev_max
      FROM memory_documents d
      JOIN spaces s ON s.id = d.space_id
      JOIN actors keeper
        ON keeper.workspace_id = d.workspace_id
       AND keeper.handle = 'roomkeeping'
       AND keeper.provisioned_by = 'system'
      JOIN messages m
        ON m.chat_id = d.chat_id AND m.ord BETWEEN d.ord_start AND d.ord_end
     GROUP BY d.bank_id, d.document_id, d.workspace_id, d.space_id, d.chat_id,
              d.ord_start, d.ord_end, d.source_rev_max, s.name, keeper.id
    HAVING MAX(m.rev) > d.source_rev_max
     ORDER BY MAX(m.rev)
     LIMIT ${limit}`.execute(db);

  return rows.rows.map((row) => ({
    bankId: row.bank_id, documentId: row.document_id, workspaceId: row.workspace_id,
    spaceId: row.space_id, chatId: row.chat_id, ordStart: row.ord_start, ordEnd: row.ord_end,
    sourceRevMax: row.source_rev_max, spaceName: row.space_name,
    writerActorId: row.writer_actor_id, currentRevMax: Number(row.current_rev_max),
  }));
}

/**
 * Rebuild one document from what is left, or drop it if nothing is.
 *
 * HINDSIGHT FIRST, THEN THE ROW — the opposite of the write path's order, and
 * for the same reason stated the other way round. Dropping the row first would
 * leave a document nothing can find, so its facts would stay recallable with no
 * record that they exist. A failed delete therefore keeps the row, and the next
 * sweep tries again: forgetting is retried until it happens rather than
 * declared done once.
 *
 * Delete-then-retain rather than a replacing retain, because the cascading
 * delete is what the stage 0 spike actually exercised (4 facts to 0) and a
 * replace is what its documentation claims.
 */
export async function rebuild(db: Kysely<DB>, stale: StaleDocument): Promise<'rebuilt' | 'dropped'> {
  const survivors = await db.selectFrom('messages as m')
    .innerJoin('actors as a', 'a.id', 'm.author_id')
    .select(['m.id', 'm.ord', 'm.rev', 'm.body', 'm.created_at', 'm.author_id',
             'a.display_name as author_display_name', 'a.handle as author_handle',
             'a.type as author_type'])
    .where('m.chat_id', '=', stale.chatId)
    .where('m.ord', '>=', stale.ordStart)
    .where('m.ord', '<=', stale.ordEnd)
    .where('m.deleted', '=', false)
    .where('m.message_kind', '=', 'actor')
    .where(visibleTo('m', stale.writerActorId))
    .orderBy('m.ord')
    .execute();

  await forget(stale.bankId, stale.documentId);

  if (survivors.length === 0) {
    // Everything that made this episode is gone. There is nothing to remember,
    // and a row pointing at a document we just deleted would be re-swept every
    // tick for ever.
    await db.deleteFrom('memory_documents')
      .where('bank_id', '=', stale.bankId)
      .where('document_id', '=', stale.documentId)
      .execute();
    return 'dropped';
  }

  const episode = survivors.map((row) => ({
    id: row.id, ord: row.ord, rev: row.rev, body: row.body,
    createdAt: new Date(row.created_at as unknown as string),
    authorId: row.author_id, authorDisplayName: row.author_display_name,
    authorHandle: row.author_handle, authorType: row.author_type,
  }));

  // The SAME document id and the SAME ordinal range, deliberately. The range is
  // where the episode was, not where its survivors are — narrowing it would
  // leave the deleted message's ordinal covered by nothing, and the next change
  // to it would be invisible to this sweep.
  await recordDocument(db, { ...stale, sourceRevMax: stale.currentRevMax });
  await retain({
    bankId: stale.bankId,
    content: buildEpisodeText(episode),
    context: `A conversation in ${stale.spaceName ?? 'a room'}. The speakers are people and ` +
             'agents working in this room. None of them is the owner of this memory bank.',
    documentId: stale.documentId,
    timestamp: episode[0]!.createdAt.toISOString(),
    tags: [`space:${stale.spaceId}`, `chat:${stale.chatId}`],
    metadata: { space_id: stale.spaceId, chat_id: stale.chatId },
  });
  return 'rebuilt';
}

export interface SweepResult {
  documentId: string;
  outcome: 'rebuilt' | 'dropped' | 'failed';
  reason?: string;
}

/** One pass. A failure on one document never stops the others. */
export async function forgetSweep(db: Kysely<DB>, limit = BATCH): Promise<SweepResult[]> {
  const results: SweepResult[] = [];
  for (const stale of await staleDocuments(db, limit)) {
    try {
      results.push({ documentId: stale.documentId, outcome: await rebuild(db, stale) });
    } catch (error) {
      // The row keeps its old `source_rev_max`, so the next sweep finds it again.
      results.push({ documentId: stale.documentId, outcome: 'failed', reason: (error as Error).name });
    }
  }
  return results;
}
