// A room's timeline, as every surface reads one (docs/MEMORY.md §14).
//
// One entry per episode — a stretch of conversation that finished — written
// once when memory ingested it and never regenerated. A PROJECTION: no agent
// reads these, no recall touches them, and nothing in the product depends on
// them being right, which is what lets them hold a second copy of the fact
// text.

/** One thing the conversation established. */
export interface TimelineFact {
  text: string;
  /**
   * Always null today, and not by oversight: extraction works on a
   * conversation rather than on a line of it, so the jump target is the
   * ENTRY's `anchorMessageId`. Kept because a future that carries per-fact
   * provenance fills it with no migration.
   */
  messageId: string | null;
  /** `decision`, `ownership`, … — null until something classifies a fact (§14.5). */
  kind: string | null;
}

export interface TimelineEntry {
  id: string;
  spaceId: string;
  chatId: string;
  ordStart: number;
  ordEnd: number;
  /** Where the conversation starts. Null once that message is deleted — the entry outlives it. */
  anchorMessageId: string | null;
  /** Epoch ms, and the MESSAGES' time: never when ingestion happened to run. */
  occurredStart: number;
  occurredEnd: number;
  title: string;
  /** Two or three sentences over the facts. Empty when narration could not run. */
  summary: string;
  facts: TimelineFact[];
  /** Actor ids, for the faces. */
  participants: string[];
  /** `episode` means unclassified — see `TimelineFact.kind`. */
  kind: string;
  significance: number;
  /** Tombstoned by the forget path: the row stays so `rev` can keep climbing. */
  deleted: boolean;
  rev: number;
  updatedAt: number;
}

/** The entries worth drawing: a tombstone is held so it cannot be resurrected, never shown. */
export const visibleEntries = (entries: readonly TimelineEntry[]): TimelineEntry[] =>
  entries.filter(entry => !entry.deleted);

/**
 * How many messages this entry covers.
 *
 * Ordinals are contiguous within a chat, so the arithmetic is honest — and it
 * is the one number that says whether an entry summarises an exchange or a
 * whole afternoon.
 */
export const messageCount = (entry: Pick<TimelineEntry, 'ordStart' | 'ordEnd'>): number =>
  entry.ordEnd - entry.ordStart + 1;

/**
 * Entries under the day they happened, newest day first, newest entry first
 * within a day.
 *
 * Grouped on `occurredStart` — when it HAPPENED — which is the whole reason
 * that column exists rather than an ingest time: a backfill that ran last night
 * must not file a conversation from March under today.
 */
export function byDay(entries: readonly TimelineEntry[]): { day: number; entries: TimelineEntry[] }[] {
  const days = new Map<number, TimelineEntry[]>();
  for (const entry of [...entries].sort((a, b) => b.occurredStart - a.occurredStart)) {
    const start = new Date(entry.occurredStart);
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
    const bucket = days.get(day);
    if (bucket) bucket.push(entry);
    else days.set(day, [entry]);
  }
  return [...days.entries()].map(([day, list]) => ({ day, entries: list }));
}
