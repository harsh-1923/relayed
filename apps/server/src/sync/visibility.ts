// Who may see a message — decided here and nowhere else
// (docs/WORKSPACE-AGENTS.md §8.5, §8.7).
//
// A restricted message has to be invisible on EVERY path that reads messages,
// not only the live one, and each path left to write the check itself is a
// path that can forget it. So the questions live in this file, and every read
// path imports them:
//
//   visibleTo(alias, reader)     the SQL clause, for any query over messages
//   redactEvent(row, reader)     a log row as this reader may receive it
//   receives(audience, reader)   the same question, for an event in memory
//
// THE CLAUSE GOES IN THE QUERY, BEFORE ANY LIMIT (invariant 79). Filtered in
// JavaScript afterwards, a backfill page with one hidden row returns 49 of 50,
// reads as "the beginning of history was reached", and the client clears
// `has_gap` over everything below — a silent permanent hole.
//
// Access to the chat is the leading conjunct and is NOT repeated here: every
// caller has already passed `can(reader, 'read', chat)`. This only narrows a
// chat the reader may read to the messages in it they may see — which is also
// why a listed actor who has left the room reads nothing, without anyone
// editing a list (AUTHZ.md, invariant 50).
import { sql, type RawBuilder } from 'kysely';
import { WITHHELD_EVENT } from '@relayed/protocol';

/**
 * Who an event or a message is for, as a writer states it.
 *
 * `stream` is everyone the stream's own audience predicate admits — for a
 * message, everyone who can read its chat. `listed` narrows that to the actors
 * named. A union rather than a nullable list at the call site, so a reader of
 * `appendEvent(…, { kind: 'stream' })` sees a decision rather than a `null`.
 */
export type Audience =
  | { kind: 'stream' }
  | { kind: 'listed'; actors: readonly string[] };

/** An audience a writer asked for that cannot be written. */
export class AudienceError extends Error {
  readonly reason: 'empty' | 'cannot_read';
  readonly actorId: string | null;
  constructor(reason: 'empty' | 'cannot_read', actorId: string | null = null) {
    super(reason === 'empty'
      ? 'a listed audience needs at least one actor'
      : `listed actor ${actorId} cannot read this chat`);
    this.name = 'AudienceError';
    this.reason = reason;
    this.actorId = actorId;
  }
}

/**
 * The column value for an audience: NULL, or a sorted list with no repeats.
 *
 * An empty list THROWS rather than being stored or mapped to NULL. Mapped to
 * NULL it would mean everyone — the fail-open shape — and the database refuses
 * it anyway (`message_visible_to`); throwing here names the writer that asked.
 */
export function toColumn(audience: Audience): string[] | null {
  if (audience.kind === 'stream') return null;
  const actors = [...new Set(audience.actors)].sort();
  if (actors.length === 0) throw new AudienceError('empty');
  return actors;
}

/** The audience a stored column describes. */
export function fromColumn(visibleTo: readonly string[] | null): Audience {
  return visibleTo === null ? { kind: 'stream' } : { kind: 'listed', actors: visibleTo };
}

/** Every table alias a message is read under. Closed, so a typo does not compile. */
type MessageAlias = 'm' | 'r' | 'messages';

/**
 * The visibility clause, for `alias`:
 *
 *   alias.visible_to IS NULL OR reader = ANY(alias.visible_to)
 *
 * No subquery: the list is on the row the query already holds. `= ANY` over a
 * list holding a NULL element is NULL for everyone not otherwise matched, which
 * a WHERE treats as false — it closes rather than opens.
 */
export function visibleTo(alias: MessageAlias, readerId: string): RawBuilder<boolean> {
  const column = sql.ref(`${alias}.visible_to`);
  return sql<boolean>`(${column} IS NULL OR ${readerId} = ANY(${column}))`;
}

/** Whether a reader of the stream receives this event's content. */
export function receives(audience: Audience, readerId: string): boolean {
  return audience.kind === 'stream' || audience.actors.includes(readerId);
}

/** A log row, in the columns redaction needs. */
export interface LogRow {
  stream_rev: number;
  event_type: string;
  payload: unknown;
  visible_to: string[] | null;
}

/** An event as one reader receives it. */
export interface RedactedEvent {
  rev: number;
  type: string;
  payload: unknown;
}

/** A log row as this reader may receive it: verbatim, or its revision alone. */
export function redactEvent(row: LogRow, readerId: string): RedactedEvent {
  return receives(fromColumn(row.visible_to), readerId)
    ? { rev: row.stream_rev, type: row.event_type, payload: row.payload }
    : withheld(row.stream_rev);
}

/** The revision without the content (WORKSPACE-AGENTS.md §8.4). */
export const withheld = (rev: number): RedactedEvent =>
  ({ rev, type: WITHHELD_EVENT, payload: {} });
