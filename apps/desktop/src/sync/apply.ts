// The contiguity frontier: what an arriving event does to it.
// Step 8 of the sync build plan (docs/SYNC-FLOWS.md §2, §11).
//
// ONE CODE PATH SERVES LIVE DELIVERY AND CATCH-UP, because they carry the same
// envelope. That is not a tidiness argument — it is what removes the whole class
// of bug where an event behaves differently depending on which door it came
// through, which is exactly the class that only appears under a reconnect.
//
// The rule everything else leans on:
//
//   rev <= frontier      DUPLICATE. Drop it. Expected under at-least-once
//                        delivery and under the live/catch-up overlap.
//   rev == frontier + 1  APPLY, advance, then drain whatever was staged above.
//   rev >  frontier + 1  A HOLE. Stage the WHOLE ENVELOPE. The frontier does
//                        not move; catch-up is what fills the gap.
//
// The effect and the cursor advance are ONE transaction. Advancing past an event
// whose effect did not land is a silent permanent hole — the client believes it
// is caught up, and nothing ever contradicts it (invariant 1).
import type { DatabaseSync } from 'node:sqlite';

/** Which stream an event belongs to. Chats, spaces, and the directory. */
export interface Stream { kind: string; id: string }

/** One event, in the shape both `ev` frames and catch-up batches carry. */
export interface Envelope {
  rev: number;
  type: string;
  payload: unknown;
}

/**
 * What applying an event did, so a caller can decide what to invalidate and
 * whether to ask for catch-up.
 *
 * `applied` lists every rev that reached the domain — the arriving one plus
 * anything the drain unblocked — because a single arriving event can advance
 * the frontier by twenty and every one of those may have touched a surface.
 */
export interface Applied {
  outcome: 'duplicate' | 'applied' | 'staged';
  frontier: number;
  applied: number[];
  /** Topics to invalidate. Empty for a duplicate or a stage. */
  topics: string[];
  /** True when a hole was recorded and catch-up is owed for this stream. */
  needsCatchup: boolean;
}

/**
 * The domain effect of one event.
 *
 * Returns the topics it touched, or an empty list for an event that legitimately
 * changed nothing. THAT IS NOT AN ERROR CASE — a delete for a message never
 * backfilled, an edit below the eviction floor, and an event type this build has
 * never heard of are all normal, and all three still account for their revision
 * (docs/SYNC-FLOWS.md §11.2). An unknown type that stalled the frontier would
 * silently stop the client receiving that stream for ever (invariant 32).
 */
export type Effect = (db: DatabaseSync, stream: Stream, event: Envelope) => string[];

export interface ApplyDeps {
  db: DatabaseSync;
  effect: Effect;
  /** Counts an event type this build does not implement. Wired at step 13. */
  onUnknown?: (type: string) => void;
}

/**
 * Apply one event, and drain anything it unblocks.
 *
 * The whole of the three-case rule, in one function on purpose. Splitting it
 * would mean a caller could reach one case without the others — and the cases
 * are only correct as a set: duplicate suppression is safe *because* a
 * higher-than-frontier event is retained rather than counted, and retention is
 * only bounded *because* the drain empties it.
 */
export function applyEvent(
  deps: ApplyDeps, stream: Stream, event: Envelope,
): Applied {
  const { db } = deps;
  const frontier = frontierOf(db, stream);

  // ── duplicate ────────────────────────────────────────────────────────────
  if (event.rev <= frontier) {
    return { outcome: 'duplicate', frontier, applied: [], topics: [], needsCatchup: false };
  }

  // ── a hole ───────────────────────────────────────────────────────────────
  if (event.rev > frontier + 1) {
    db.exec('BEGIN');
    try {
      stage(db, stream, event);
      // The head is at LEAST this far along. `max` rather than assignment: a
      // catch-up reply may already have told us about something further ahead,
      // and a live event arriving late must not walk that back.
      db.prepare(`
        INSERT INTO stream_state (stream_kind, stream_id, server_head_rev)
        VALUES (?, ?, ?)
        ON CONFLICT(stream_kind, stream_id) DO UPDATE SET
          server_head_rev = MAX(stream_state.server_head_rev, excluded.server_head_rev)
      `).run(stream.kind, stream.id, event.rev);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    return {
      outcome: 'staged', frontier, applied: [], topics: [],
      // ONE coalesced catch-up per stream, decided by the caller. Asking per
      // staged event would send a request per hole, and a client that fell
      // behind by a hundred events would ask a hundred times.
      needsCatchup: true,
    };
  }

  // ── at the frontier ──────────────────────────────────────────────────────
  const applied: number[] = [];
  const topics = new Set<string>();

  db.exec('BEGIN');
  try {
    let next: Envelope | null = event;
    let at = frontier;

    // The drain is a loop rather than a second entry point, and it runs inside
    // the SAME transaction: an event that unblocks twenty others either applies
    // all twenty-one or none. Half a drain would leave the frontier claiming
    // revisions whose effects rolled back.
    while (next) {
      for (const topic of deps.effect(db, stream, next)) topics.add(topic);
      at = next.rev;
      applied.push(at);
      next = takeStaged(db, stream, at + 1);
    }

    db.prepare(`
      INSERT INTO stream_state (stream_kind, stream_id, synced_through_rev, server_head_rev)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(stream_kind, stream_id) DO UPDATE SET
        synced_through_rev = excluded.synced_through_rev,
        server_head_rev = MAX(stream_state.server_head_rev, excluded.server_head_rev)
    `).run(stream.kind, stream.id, at, at);

    // Everything at or below the frontier is either applied or a duplicate, so
    // nothing below it may remain staged. This is what keeps the table bounded
    // by the current out-of-order window rather than by history — it collapses
    // to empty whenever the client is caught up.
    db.prepare('DELETE FROM staged_events WHERE stream_kind = ? AND stream_id = ? AND rev <= ?')
      .run(stream.kind, stream.id, at);

    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return {
    outcome: 'applied', frontier: applied[applied.length - 1] as number,
    applied, topics: [...topics], needsCatchup: false,
  };
}

/**
 * Apply a catch-up batch, in order.
 *
 * The same rule per event, deliberately — a batch is not a special case, it is
 * a sequence of ordinary arrivals. Anything already held is a duplicate and is
 * dropped; anything above a hole is staged and drained when the hole fills.
 */
export function applyBatch(
  deps: ApplyDeps, stream: Stream, events: readonly Envelope[],
): Applied {
  let last: Applied = {
    outcome: 'duplicate', frontier: frontierOf(deps.db, stream),
    applied: [], topics: [], needsCatchup: false,
  };
  const applied: number[] = [];
  const topics = new Set<string>();
  let needsCatchup = false;

  for (const event of [...events].sort((a, b) => a.rev - b.rev)) {
    last = applyEvent(deps, stream, event);
    applied.push(...last.applied);
    for (const topic of last.topics) topics.add(topic);
    // A hole INSIDE a batch means the batch itself was short — the server
    // truncated it, or events were retired under retention. Either way the
    // stream still owes a catch-up, and forgetting that here is how a client
    // sits one event behind for ever.
    if (last.needsCatchup) needsCatchup = true;
  }

  return {
    outcome: applied.length > 0 ? 'applied' : last.outcome,
    frontier: frontierOf(deps.db, stream),
    applied, topics: [...topics], needsCatchup,
  };
}

/** How far this stream has been applied, contiguously. Zero if never seen. */
export function frontierOf(db: DatabaseSync, stream: Stream): number {
  const row = db.prepare(
    'SELECT synced_through_rev FROM stream_state WHERE stream_kind = ? AND stream_id = ?',
  ).get(stream.kind, stream.id) as { synced_through_rev: number } | undefined;
  return row?.synced_through_rev ?? 0;
}

/** What the server last told us exists. The other half of "how far behind". */
export function headOf(db: DatabaseSync, stream: Stream): number {
  const row = db.prepare(
    'SELECT server_head_rev FROM stream_state WHERE stream_kind = ? AND stream_id = ?',
  ).get(stream.kind, stream.id) as { server_head_rev: number } | undefined;
  return row?.server_head_rev ?? 0;
}

/**
 * Every stream that is behind, for the catch-up scheduler to work through.
 *
 * Tracked explicitly rather than derived from message rows, because "have I
 * seen rev N" is not answerable from them: a delete for a message never held
 * writes nothing at all, and an edit overwrites the revision it replaced.
 */
export function behind(db: DatabaseSync): { stream: Stream; from: number; to: number }[] {
  const rows = db.prepare(`
    SELECT stream_kind, stream_id, synced_through_rev, server_head_rev
      FROM stream_state
     WHERE server_head_rev > synced_through_rev
  `).all() as {
    stream_kind: string; stream_id: string;
    synced_through_rev: number; server_head_rev: number;
  }[];
  return rows.map(row => ({
    stream: { kind: row.stream_kind, id: row.stream_id },
    from: row.synced_through_rev,
    to: row.server_head_rev,
  }));
}

function stage(db: DatabaseSync, stream: Stream, event: Envelope): void {
  db.prepare(`
    INSERT INTO staged_events (stream_kind, stream_id, rev, event_type, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(stream_kind, stream_id, rev) DO NOTHING
  `).run(stream.kind, stream.id, event.rev, event.type, JSON.stringify(event.payload));
}

/** Take one staged event by rev, removing it. Null when the run ends. */
function takeStaged(db: DatabaseSync, stream: Stream, rev: number): Envelope | null {
  const row = db.prepare(`
    SELECT event_type, payload FROM staged_events
     WHERE stream_kind = ? AND stream_id = ? AND rev = ?
  `).get(stream.kind, stream.id, rev) as
    { event_type: string; payload: string } | undefined;
  if (!row) return null;
  return { rev, type: row.event_type, payload: JSON.parse(row.payload) as unknown };
}
