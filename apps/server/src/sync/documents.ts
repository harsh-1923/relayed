// Documents (docs/DOCUMENTS.md §3): text that belongs to a space and changes
// over time, as opposed to a message, which is an event that happened.
//
// The first kind is the summary every room keeps. Nothing writes one yet — the
// summariser is a later step — so what is here is the structure: created with
// its room, read back for `welcome` and for somebody joining, and carried on
// the space stream when it changes.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/schema.ts';
import { ulid } from '../db/ulid.ts';
import { allocateStream } from './allocate.ts';
import { appendEvent, spaceStream, type AppendedEvent, type DocumentUpdated } from './events.ts';

/** The title a room's summary panel carries. Not the document's content, and never empty. */
export const ROOM_SUMMARY_TITLE = 'Summary';

const DOCUMENT_COLUMNS = ['id', 'space_id', 'kind', 'title', 'body', 'format', 'rev',
  'updated_by_actor_id', 'covered_through', 'updated_at'] as const;

interface DocumentRow {
  id: string;
  space_id: string;
  kind: string;
  title: string | null;
  body: string;
  format: string;
  rev: number;
  updated_by_actor_id: string | null;
  covered_through: unknown;
  updated_at: unknown;
}

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

/** A row as the wire carries it — the complete document, which is what makes applying it one upsert (§7.1). */
export function toDocumentUpdated(row: DocumentRow): DocumentUpdated {
  return {
    id: row.id, space_id: row.space_id, kind: row.kind, title: row.title,
    body: row.body, format: row.format, rev: Number(row.rev),
    updated_by_actor_id: row.updated_by_actor_id,
    covered_through: coveredThrough(row.covered_through),
    updated_at: iso(row.updated_at),
  };
}

/** `{ [chatId]: ord }`, or null. Read leniently: a shape this build does not recognise is no watermark, not a throw. */
function coveredThrough(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [chatId, ord] of Object.entries(value as Record<string, unknown>)) {
    if (typeof ord === 'number' && Number.isFinite(ord)) out[chatId] = ord;
  }
  return out;
}

/**
 * The summary document a room is created with, and the structural panel it is
 * read in (§4.1, §8.1).
 *
 * Inside the caller's transaction, and inside the room's own creation: a room
 * whose panel exists but whose document does not is a tab that renders an
 * error, and one transaction is what stops that being a state anyone can reach.
 *
 * It starts at `rev = 0` with an empty body. That is not a missing value — it
 * is a room nobody has said anything in yet, and the panel says so.
 */
export async function createRoomSummary(
  trx: Transaction<DB>, input: { workspaceId: string; spaceId: string },
): Promise<{ documentId: string; panelId: string }> {
  const documentId = ulid('doc');
  const panelId = ulid('pnl');

  await trx.insertInto('documents').values({
    id: documentId, workspace_id: input.workspaceId, space_id: input.spaceId,
    kind: 'room_summary', title: ROOM_SUMMARY_TITLE,
  }).execute();

  await trx.insertInto('panels').values({
    id: panelId, workspace_id: input.workspaceId, space_id: input.spaceId, type: 'doc',
    chat_id: null, payload: sql`${JSON.stringify({ document_id: documentId })}::jsonb`,
    title: ROOM_SUMMARY_TITLE, opened_from_chat_id: null,
    created_by_actor_id: null, on_behalf_of_actor_id: null, removed_at: null,
  }).execute();

  return { documentId, panelId };
}

/** A summary body is capped so both the panel and the NEXT prompt stay bounded (§4.5). */
export const BODY_LIMIT_BYTES = 8 * 1024;

/** How many revisions a document keeps. Pruned by the writer, not by a sweep (§3.3). */
export const REVISION_RETENTION = 50;

/**
 * Write the next revision of a document — the ONE write path (§4.2).
 *
 * Both writers come through here: the summariser job, and Roomkeeping when
 * somebody asks it to change the summary (§4.8). Four writes that have to
 * happen together — bump `rev`, append the revision, prune, emit — and a
 * second implementation of them is how two writers start disagreeing about
 * what `rev` means.
 *
 * `coveredThrough` is OPTIONAL, and its absence is a decision rather than a
 * missing value: a person asking for an edit is not a pass over the messages,
 * so the watermark stays where it was and the next scheduled refresh still
 * covers what it would have (§4.8).
 *
 * The row is locked for the duration, so two writers landing together produce
 * two revisions in order rather than one overwriting the other.
 */
export async function writeDocumentRevision(
  db: Kysely<DB>,
  input: {
    documentId: string;
    body: string;
    authorActorId: string;
    coveredThrough?: Record<string, number> | null;
  },
): Promise<{ event: AppendedEvent; rev: number }> {
  const body = capBytes(input.body, BODY_LIMIT_BYTES);
  return db.transaction().execute(async (trx) => {
    const current = await trx.selectFrom('documents')
      .select(['id', 'space_id', 'rev'])
      .where('id', '=', input.documentId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const rev = Number(current.rev) + 1;

    const row = await trx.updateTable('documents')
      .set({
        body, rev, updated_by_actor_id: input.authorActorId, updated_at: sql`now()`,
        ...(input.coveredThrough === undefined
          ? {}
          : { covered_through: sql`${JSON.stringify(input.coveredThrough)}::jsonb` }),
        // A write is a success by definition: whatever was failing has stopped,
        // and the lease is released for the next pass.
        refresh_failures: 0, refresh_lease_until: null,
      })
      .where('id', '=', input.documentId)
      .returning(DOCUMENT_COLUMNS)
      .executeTakeFirstOrThrow();

    await trx.insertInto('document_revisions').values({
      document_id: input.documentId, rev, body, author_actor_id: input.authorActorId,
      covered_through: sql`${JSON.stringify(coveredThrough(row.covered_through))}::jsonb`,
    }).execute();

    // Pruned by the writer, here, rather than by a sweep that has to find work:
    // exactly one document can be over the limit at this moment, and it is this
    // one.
    await trx.deleteFrom('document_revisions')
      .where('document_id', '=', input.documentId)
      .where('rev', '<=', rev - REVISION_RETENTION)
      .execute();

    const allocated = await allocateStream(trx, spaceStream(current.space_id));
    const event = await appendEvent(
      trx, allocated, 'document.updated', toDocumentUpdated(row as DocumentRow), { kind: 'stream' });
    return { event, rev };
  });
}

/**
 * Trim to a byte budget on a character boundary.
 *
 * Bytes, not characters, because both things the cap protects — the panel's
 * frame and the next prompt's context — are measured in bytes, and 8 KB of
 * emoji is not 8 KB. The tail is dropped rather than the head: a summary's
 * opening sentences are the part somebody actually reads.
 */
function capBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  const cut = Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8');
  // A multi-byte character split by `subarray` decodes to U+FFFD; dropping a
  // trailing one is what keeps the result valid text rather than nearly-valid.
  return cut.endsWith('�') ? cut.slice(0, -1) : cut;
}

/**
 * The documents of these spaces — for `welcome`, and for somebody who has just
 * been added to a room, so they have the summary before they have read a single
 * message (§7.3).
 */
export async function spaceDocuments(
  db: Kysely<DB> | Transaction<DB>, spaceIds: readonly string[],
): Promise<DocumentUpdated[]> {
  if (spaceIds.length === 0) return [];
  const rows = await db.selectFrom('documents').select(DOCUMENT_COLUMNS)
    .where('space_id', 'in', spaceIds)
    .orderBy('created_at')
    .execute();
  return rows.map(row => toDocumentUpdated(row as DocumentRow));
}
