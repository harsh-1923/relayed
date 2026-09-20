// A room's timeline (docs/MEMORY.md §14): an episode written down for people to
// read, as replicated rows.
//
// THE SYNC LAYER OWNS THE ROW AND THE EVENT; memory decides what goes in it.
// That split is what keeps a vendor out of the sync protocol: `ingest.ts` calls
// `writeTimelineEntry` with text it has already read back from Hindsight, and
// nothing here knows Hindsight exists.
//
// A PROJECTION, NEVER A SOURCE OF TRUTH. No agent reads these rows and no
// recall touches them — which is what licenses a second copy of the fact text
// beside the one in the bank. It cannot disagree with anything, because nothing
// depends on it.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/schema.ts';
import { ulid } from '../db/ulid.ts';
import { allocateStream } from './allocate.ts';
import { appendEvent, spaceStream, type AppendedEvent, type TimelineEntry } from './events.ts';

/** One bullet: what was established, and the message it was established in. */
export interface TimelineFact {
  text: string;
  /** Null once the message it cited is gone. The entry outlives it (§14.3). */
  message_id: string | null;
  /** Null until something classifies facts — see `UNCLASSIFIED` (§14.5). */
  kind: string | null;
}

/**
 * The `kind` of an entry nothing has classified.
 *
 * NOT a placeholder for laziness. §14.5 assumed the fact kinds were free
 * because §6.2's extraction instructions enumerate them — but those
 * instructions STEER extraction in prose and nothing labels what comes back.
 * Hindsight's own `type` is `world`/`experience`/`observation`, which says
 * nothing about decision-versus-reference. So until something classifies them,
 * every entry is one of these and the "Decisions only" filter has nothing to
 * filter on.
 */
export const UNCLASSIFIED = 'episode';

/**
 * Which spaces keep a timeline: rooms, and only rooms.
 *
 * NOT a property of the tables — `room_timeline_entries` is keyed on a space of
 * any kind, and the write path would happily fill one for a DM. It is a
 * property of the SURFACE: the panel a timeline is read in is structural to a
 * room and exists nowhere else (`isStructuralPanel`), so an entry written for a
 * channel or a DM is a row, an event and a narration call that no one can ever
 * see.
 *
 * Expressed once, here, rather than as a condition at each writer — the ingest
 * pass and the backfill both ask this, and a third writer forgetting it would
 * be invisible until somebody counted rows.
 */
export const spaceHasTimeline = (spaceKind: string): boolean => spaceKind === 'room';

const TIMELINE_COLUMNS = ['id', 'space_id', 'chat_id', 'ord_start', 'ord_end', 'anchor_message_id',
  'occurred_start', 'occurred_end', 'title', 'summary', 'facts', 'participants', 'kind',
  'significance', 'deleted', 'rev', 'updated_at'] as const;

interface TimelineRow {
  id: string;
  space_id: string;
  chat_id: string;
  ord_start: number;
  ord_end: number;
  anchor_message_id: string | null;
  occurred_start: unknown;
  occurred_end: unknown;
  title: string;
  summary: string;
  facts: unknown;
  participants: unknown;
  kind: string;
  significance: number;
  deleted: boolean;
  rev: number;
  updated_at: unknown;
}

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

/**
 * Read a stored JSON array leniently: a shape this build does not recognise is
 * an empty list, not a throw.
 *
 * The reason is the one `coveredThrough` gives in `documents.ts` — this runs on
 * the path that answers `welcome`, and one malformed row must not be able to
 * stop a client connecting.
 */
function readFacts(value: unknown): TimelineFact[] {
  if (!Array.isArray(value)) return [];
  const out: TimelineFact[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const fact = entry as Record<string, unknown>;
    if (typeof fact.text !== 'string' || fact.text.length === 0) continue;
    out.push({
      text: fact.text,
      message_id: typeof fact.message_id === 'string' ? fact.message_id : null,
      kind: typeof fact.kind === 'string' ? fact.kind : null,
    });
  }
  return out;
}

const readParticipants = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

/** A row as the wire carries it — the complete entry, so applying it is one upsert. */
export function toTimelineEntry(row: TimelineRow): TimelineEntry {
  return {
    id: row.id, space_id: row.space_id, chat_id: row.chat_id,
    ord_start: Number(row.ord_start), ord_end: Number(row.ord_end),
    anchor_message_id: row.anchor_message_id,
    occurred_start: iso(row.occurred_start), occurred_end: iso(row.occurred_end),
    title: row.title, summary: row.summary,
    facts: readFacts(row.facts),
    participants: readParticipants(row.participants),
    kind: row.kind, significance: Number(row.significance),
    deleted: row.deleted, rev: Number(row.rev),
    updated_at: iso(row.updated_at),
  };
}

export interface TimelineEntryInput {
  workspaceId: string;
  spaceId: string;
  chatId: string;
  ordStart: number;
  ordEnd: number;
  anchorMessageId: string | null;
  occurredStart: Date;
  occurredEnd: Date;
  title: string;
  /** Two or three sentences over the facts. Empty when narration failed. */
  summary: string;
  facts: readonly TimelineFact[];
  participants: readonly string[];
  kind?: string;
  significance?: number;
}

/**
 * Write the entry for one episode — the ONE write path.
 *
 * AN UPSERT KEYED ON THE EPISODE, not an insert. An episode is identified by
 * where it sits (`chat_id`, `ord_start`, `ord_end`), so re-ingesting the same
 * range lands on the same row: the forget path re-retains a range without a
 * deleted message, and that has to correct the entry rather than add a second
 * one saying almost the same thing. The unique index in 029 is what makes that
 * true rather than every writer remembering to look first.
 *
 * `rev` climbs on every write, `documents.rev`'s rule, so a client keeps the
 * highest it has seen and an event arriving late cannot wind it back.
 *
 * Writing an entry UNDELETES it, which is deliberate: the only thing that
 * tombstones an entry is an episode with nothing left in it, and a later
 * rebuild that finds something again should bring it back rather than write to
 * a row no reader will draw.
 */
export async function writeTimelineEntry(
  db: Kysely<DB>, input: TimelineEntryInput,
): Promise<{ event: AppendedEvent; entry: TimelineEntry }> {
  return db.transaction().execute(async (trx) => {
    const row = await trx.insertInto('room_timeline_entries')
      .values({
        id: ulid('tle'),
        workspace_id: input.workspaceId, space_id: input.spaceId, chat_id: input.chatId,
        ord_start: input.ordStart, ord_end: input.ordEnd,
        anchor_message_id: input.anchorMessageId,
        occurred_start: input.occurredStart, occurred_end: input.occurredEnd,
        title: input.title, summary: input.summary,
        facts: sql`${JSON.stringify(input.facts)}::jsonb`,
        participants: sql`${JSON.stringify(input.participants)}::jsonb`,
        kind: input.kind ?? UNCLASSIFIED,
        significance: input.significance ?? 0,
      })
      .onConflict(conflict => conflict
        .columns(['chat_id', 'ord_start', 'ord_end'])
        .doUpdateSet(eb => ({
          anchor_message_id: eb.ref('excluded.anchor_message_id'),
          occurred_start: eb.ref('excluded.occurred_start'),
          occurred_end: eb.ref('excluded.occurred_end'),
          title: eb.ref('excluded.title'),
          summary: eb.ref('excluded.summary'),
          facts: eb.ref('excluded.facts'),
          participants: eb.ref('excluded.participants'),
          kind: eb.ref('excluded.kind'),
          significance: eb.ref('excluded.significance'),
          deleted: false,
          rev: sql`room_timeline_entries.rev + 1`,
          updated_at: sql`now()`,
        })))
      .returning(TIMELINE_COLUMNS)
      .executeTakeFirstOrThrow();

    const entry = toTimelineEntry(row as TimelineRow);
    const allocated = await allocateStream(trx, spaceStream(input.spaceId));
    const event = await appendEvent(trx, allocated, 'timeline.entry', entry, { kind: 'stream' });
    return { event, entry };
  });
}

/**
 * Tombstone an entry: the episode it described has nothing left worth keeping.
 *
 * A TOMBSTONE, NOT A DELETE, and the same call `removeMember` makes for the
 * same reason — `rev` has to keep climbing across the removal. A deleted row
 * has no `rev` to compare against, so an update still in flight would land
 * afterwards and resurrect an entry no reader could get rid of again.
 *
 * Returns null when there is no such entry, which is not an error: the forget
 * path runs over memory documents, and one written before this table existed
 * has no entry to tombstone.
 */
export async function tombstoneTimelineEntry(
  db: Kysely<DB>, where: { chatId: string; ordStart: number; ordEnd: number },
): Promise<AppendedEvent | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx.updateTable('room_timeline_entries')
      .set({ deleted: true, rev: sql`rev + 1`, updated_at: sql`now()` })
      .where('chat_id', '=', where.chatId)
      .where('ord_start', '=', where.ordStart)
      .where('ord_end', '=', where.ordEnd)
      .where('deleted', '=', false)
      .returning(TIMELINE_COLUMNS)
      .executeTakeFirst();
    if (!row) return null;

    const allocated = await allocateStream(trx, spaceStream(row.space_id));
    return appendEvent(
      trx, allocated, 'timeline.entry', toTimelineEntry(row as TimelineRow), { kind: 'stream' });
  });
}

/**
 * The timeline of these spaces — for `welcome`, and for somebody just added to
 * a room, so they have its history before they have read a single message.
 *
 * CAPPED PER SPACE, which `spaceDocuments` has no need to be: a room's summary
 * is one row, and its timeline grows for ever. The newest page is what the
 * panel opens on, and scrolling further is a query against the replica the
 * client already holds — not a bigger `welcome`.
 *
 * Tombstones come too. A client that holds a deleted entry needs the row that
 * says so; one that never saw it simply stores a row it will not draw.
 */
export const WELCOME_ENTRIES_PER_SPACE = 50;

export async function spaceTimelineEntries(
  db: Kysely<DB> | Transaction<DB>, spaceIds: readonly string[],
): Promise<TimelineEntry[]> {
  if (spaceIds.length === 0) return [];
  // ONE statement for every space, not one per space: `welcome` is a constant
  // number of round trips and a per-room read would make it linear.
  //
  // `row_number()` rather than a correlated `LIMIT`/`OFFSET` subquery. The
  // obvious shape — "newer than this space's 50th entry" — returns NULL for a
  // space with fewer than 50, and `occurred_start >= NULL` is not false but
  // UNKNOWN, so every young room would have come back with an empty timeline.
  const { rows } = await sql<TimelineRow>`
    SELECT id, space_id, chat_id, ord_start, ord_end, anchor_message_id,
           occurred_start, occurred_end, title, summary, facts, participants, kind,
           significance, deleted, rev, updated_at
      FROM (SELECT t.*, row_number() OVER (PARTITION BY t.space_id
                                               ORDER BY t.occurred_start DESC, t.id DESC) AS n
              FROM room_timeline_entries t
             WHERE t.space_id = ANY(${sql.val(spaceIds)})) ranked
     WHERE n <= ${WELCOME_ENTRIES_PER_SPACE}
     ORDER BY occurred_start DESC, id DESC
  `.execute(db);
  return rows.map(toTimelineEntry);
}
