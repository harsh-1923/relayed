// What an agent reads (docs/WORKSPACE-AGENTS.md §5.6).
//
// Built from messages BOTH the agent and the invoker may read — the
// intersection `DESIGN.md` §6.4 requires of every Relayed resource an agent
// touches on someone's behalf. Nothing here fetches with only one of their
// eyes.
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { visibleToBoth } from '../sync/visibility.ts';
import { personLabel } from './people.ts';

/** The text budget `prompt` is capped to, per §5.6. */
export const SIZE_LIMIT_BYTES = 24 * 1024;
/** The chat's last N top-level messages when the trigger is not a thread reply. */
export const TOP_LEVEL_LIMIT = 40;

interface Row {
  id: string;
  ord: number;
  body: string;
  author_id: string;
  author_display_name: string;
  author_handle: string;
  author_type: string;
}

const ROW_COLUMNS = [
  'm.id', 'm.ord', 'm.body', 'm.author_id',
  'a.display_name as author_display_name', 'a.handle as author_handle',
  'a.type as author_type',
] as const;

/** Strip only THIS agent's mention from a body; mentions of anyone else stay. */
function stripOwnMention(body: string, agentActorId: string): string {
  return body
    .replaceAll(new RegExp(`\\[[^\\]]*\\]\\(actor:${agentActorId}\\)`, 'g'), '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** The author, with the id the agent links them by (`people.ts`). */
function label(row: Row, agentActorId: string, isTrigger: boolean): string {
  const author = { id: row.author_id, displayName: row.author_display_name, handle: row.author_handle };
  const who = personLabel(author, row.author_id === agentActorId ? 'you'
    : row.author_type === 'agent' ? 'agent' : undefined);
  return isTrigger ? `${who}, request` : who;
}

export interface TriggerRef {
  id: string;
  chatId: string;
  parentId: string | null;
  ord: number;
}

/**
 * The transcript for one run: everything §5.6 asks for, joined into `prompt`.
 *
 * Thread or channel is decided by the trigger alone: a thread reply reads its
 * whole thread, up to and including the trigger; anything else reads the
 * chat's last `TOP_LEVEL_LIMIT` top-level messages, likewise capped at the
 * trigger. Never past it — a reply arriving after the mention was sent is not
 * part of what prompted this run, however soon the dispatcher gets to it.
 *
 * Two runs of the same agent read independently: each call is its own query,
 * with no memory between them (§5.6, "neither sees the other's answer until
 * the next mention").
 */
export async function buildTranscript(
  db: Kysely<DB>, trigger: TriggerRef, agentActorId: string, invokerActorId: string,
): Promise<string> {
  const rootId = trigger.parentId ?? trigger.id;
  const base = () => db.selectFrom('messages as m')
    .innerJoin('actors as a', 'a.id', 'm.author_id')
    .select(ROW_COLUMNS)
    .where('m.chat_id', '=', trigger.chatId)
    .where('m.ord', '<=', trigger.ord)
    .where('m.deleted', '=', false)
    .where(visibleToBoth('m', agentActorId, invokerActorId));

  const rows: Row[] = trigger.parentId !== null
    ? await base()
        .where(eb => eb.or([eb('m.id', '=', rootId), eb('m.parent_id', '=', rootId)]))
        .orderBy('m.ord')
        .execute()
    : await base()
        .where('m.parent_id', 'is', null)
        .orderBy('m.ord', 'desc')
        .limit(TOP_LEVEL_LIMIT)
        .execute()
        .then(page => page.reverse());

  // The size cap drops from the OLDEST end. The trigger is always kept, even
  // if it alone would exceed the cap: a run with no request at all is worse
  // than one whose context ran short.
  const lines: string[] = [];
  let bytes = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row) continue;
    const isTrigger = row.id === trigger.id;
    const text = isTrigger ? stripOwnMention(row.body, agentActorId) : row.body;
    const line = `${label(row, agentActorId, isTrigger)}: ${text}`;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (!isTrigger && bytes + lineBytes > SIZE_LIMIT_BYTES) break;
    lines.unshift(line);
    bytes += lineBytes;
  }
  return lines.join('\n');
}
