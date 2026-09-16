// A document, as every surface reads one (docs/DOCUMENTS.md).
//
// Text that belongs to a space and changes over time — a room's running
// summary, today — as opposed to a message, which is an event that happened.

export interface Document {
  id: string;
  spaceId: string;
  /** `room_summary` today. A kind this build does not know is kept and drawn as a placeholder, never dropped. */
  kind: string;
  title: string | null;
  body: string;
  /** `markdown` today; a document whose format this build cannot render says so rather than showing its source. */
  format: string;
  /** Monotonic per document. Rendered nowhere; it is what stops an older body replacing a newer one. */
  rev: number;
  /** Who wrote this revision — an agent, for a summary. */
  updatedByActorId: string | null;
  /** `{ [chatId]: ord }` — how far its writer had read, for the panel's "covers up to" line. */
  coveredThrough: Record<string, number> | null;
  updatedAt: number;
}

/** A room's summary, or null. Exactly one per room by a unique index on the server. */
export const roomSummary = (documents: readonly Document[]): Document | null =>
  documents.find(document => document.kind === 'room_summary') ?? null;

/** Nothing written yet: a room nobody has said anything in, not a document that failed to load. */
export const isEmptyDocument = (document: Pick<Document, 'rev' | 'body'>): boolean =>
  document.rev === 0 || document.body.trim().length === 0;
