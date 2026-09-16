// A room's shared panels (docs/PANELS.md): the surfaces people in a room work
// beside the conversation. The first writer is an agent opening a page for the
// room — a ticket it filed, a dashboard it found — so everyone there sees it.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/schema.ts';
import { ulid } from '../db/ulid.ts';
import { allocateStream } from './allocate.ts';
import { appendEvent, spaceStream, type AppendedEvent, type PanelOpened } from './events.ts';

/** Long enough for any real ticket or dashboard link; short enough that a URL is never a payload. */
const MAX_URL_LENGTH = 2048;

export type UrlRefusal = 'not_a_url' | 'not_https' | 'private_address' | 'credentials' | 'too_long';

/**
 * Whether a URL may be opened for a whole room, and in what normalised form.
 *
 * Every member's app loads it, so it must not be able to reach anything of
 * theirs: https only, and never a loopback, private or link-local address,
 * which on each person's machine would be THEIR localhost or home network.
 * An IP literal is refused outright — tickets, dashboards and documents have
 * names — which also closes the many ways to spell a private address.
 *
 * Not closed here: a public name that resolves to a private address. Each
 * client resolves it itself, so the server cannot check what they will reach;
 * the page still loads sandboxed, in the panels' own session (PANELS.md §10.3).
 */
export function roomPanelUrl(raw: string): { ok: true; url: string } | { ok: false; reason: UrlRefusal } {
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return { ok: false, reason: 'not_a_url' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };

  const host = url.hostname.toLowerCase();
  const ipLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':');
  const localName = host === 'localhost' || !host.includes('.')
    || /\.(localhost|local|internal|lan|home|corp|intranet|test|invalid|example)$/.test(host);
  if (ipLiteral || localName) return { ok: false, reason: 'private_address' };

  return { ok: true, url: url.toString() };
}

export class NotARoomError extends Error {
  constructor(spaceId: string) { super(`space ${spaceId} is not a room`); this.name = 'NotARoomError'; }
}
export class PrivateChatError extends Error {
  constructor(chatId: string) { super(`chat ${chatId} is private`); this.name = 'PrivateChatError'; }
}

export interface OpenRoomPanel {
  chatId: string;
  url: string;
  title: string | null;
  createdBy: string;
  onBehalfOf: string | null;
}

type PanelRow = {
  id: string; space_id: string; type: string; payload: unknown; title: string | null;
  opened_from_chat_id: string | null; created_by_actor_id: string | null; on_behalf_of_actor_id: string | null;
  created_at: unknown; opened_at: unknown;
};

const urlOf = (payload: unknown): string => {
  const url = (payload as { url?: unknown } | null)?.url;
  return typeof url === 'string' ? url : '';
};

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

function toPanelOpened(row: PanelRow): PanelOpened {
  const documentId = row.type === 'doc' ? documentIdOf(row.payload) : null;
  return {
    id: row.id, space_id: row.space_id, type: documentId ? 'doc' : 'web',
    payload: documentId ? { document_id: documentId } : { url: urlOf(row.payload) },
    title: row.title, opened_from_chat_id: row.opened_from_chat_id,
    created_by_actor_id: row.created_by_actor_id, on_behalf_of_actor_id: row.on_behalf_of_actor_id,
    created_at: iso(row.created_at), opened_at: iso(row.opened_at),
  };
}

/** A doc panel's document (DOCUMENTS.md §8.1). Empty is impossible — `createRoomSummary` writes both — but read leniently anyway. */
function documentIdOf(payload: unknown): string | null {
  const id = (payload as { document_id?: unknown } | null)?.document_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

const PANEL_COLUMNS = ['id', 'space_id', 'type', 'payload', 'title', 'opened_from_chat_id',
  'created_by_actor_id', 'on_behalf_of_actor_id', 'created_at', 'opened_at'] as const;

/**
 * Open a web page for everyone in the room the chat belongs to — or bring the
 * room's existing panel for that page forward. One transaction: the row and its
 * `panel.opened` event commit together, and the caller delivers the event after.
 *
 * Refused for a space that is not a room, and for a private chat: announcing a
 * page on the room's stream would tell every member what was said somewhere
 * only some of them can read (DESIGN.md §7.2).
 */
export async function openRoomPanel(
  db: Kysely<DB>, input: OpenRoomPanel,
): Promise<{ panel: PanelOpened; event: AppendedEvent }> {
  return db.transaction().execute(async (trx) => {
    const chat = await trx.selectFrom('chats')
      .innerJoin('spaces', 'spaces.id', 'chats.space_id')
      .select(['chats.id as chat_id', 'chats.kind as chat_kind', 'spaces.id as space_id',
               'spaces.kind as space_kind', 'spaces.workspace_id as workspace_id'])
      .where('chats.id', '=', input.chatId)
      .executeTakeFirstOrThrow();
    if (chat.space_kind !== 'room') throw new NotARoomError(chat.space_id);
    if (chat.chat_kind === 'private') throw new PrivateChatError(chat.chat_id);

    // Allocated FIRST: it locks the space's row, so two opens of the same page
    // at once serialise here and the second finds the first's panel.
    const allocated = await allocateStream(trx, spaceStream(chat.space_id));

    const existing = await trx.selectFrom('panels').select(PANEL_COLUMNS)
      .where('space_id', '=', chat.space_id).where('type', '=', 'web').where('removed_at', 'is', null)
      .where(sql<string>`payload->>'url'`, '=', input.url)
      .executeTakeFirst();

    const row = existing
      ? await trx.updateTable('panels')
        .set({
          opened_at: sql`now()`,
          ...(input.title ? { title: input.title } : {}),
          created_by_actor_id: input.createdBy, on_behalf_of_actor_id: input.onBehalfOf,
          opened_from_chat_id: input.chatId,
        })
        .where('id', '=', existing.id)
        .returning(PANEL_COLUMNS).executeTakeFirstOrThrow()
      : await trx.insertInto('panels').values({
        id: ulid('pnl'), workspace_id: chat.workspace_id, space_id: chat.space_id, type: 'web',
        payload: sql`${JSON.stringify({ url: input.url })}::jsonb`, title: input.title,
        opened_from_chat_id: input.chatId, created_by_actor_id: input.createdBy,
        on_behalf_of_actor_id: input.onBehalfOf, removed_at: null, chat_id: null,
      }).returning(PANEL_COLUMNS).executeTakeFirstOrThrow();

    const panel = toPanelOpened(row as PanelRow);
    const event = await appendEvent(trx, allocated, 'panel.opened', panel, { kind: 'stream' });
    return { panel, event };
  });
}

/** The open panels of these rooms, most recently opened first — for `welcome` and for a newly added member. */
export async function roomPanels(
  db: Kysely<DB> | Transaction<DB>, spaceIds: readonly string[],
): Promise<PanelOpened[]> {
  if (spaceIds.length === 0) return [];
  const rows = await db.selectFrom('panels').select(PANEL_COLUMNS)
    .where('space_id', 'in', spaceIds).where('type', 'in', ['web', 'doc']).where('removed_at', 'is', null)
    .orderBy('opened_at', 'desc')
    .execute();
  return rows.map(row => toPanelOpened(row as PanelRow));
}
