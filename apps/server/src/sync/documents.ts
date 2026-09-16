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
import type { DocumentUpdated } from './events.ts';

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
