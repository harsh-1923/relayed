// How long the log is kept, and what happens to a client that falls past it.
// Step 12 of the sync build plan (docs/SYNC-FLOWS.md §2).
//
// THE INTERESTING PART IS NOT THE DELETE. Sweeping old rows is easy; the risk is
// what a client asking about them then gets. Below, `retainedFrom` is what makes
// a swept range answerable at all — without it a client at a cursor beneath the
// floor is told "nothing changed" for ever while the head runs away from it.
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { ulidFloor } from '../db/ulid.ts';
import type { Stream } from './events.ts';

/**
 * How long an event stays replayable.
 *
 * SEVEN DAYS, and the number is chosen against the gap threshold rather than
 * independently. The two interact: a client inside the horizon replays, a client
 * outside it gets current state plus a marked floor. So the horizon answers
 * "how long may somebody be away and still resume exactly where they were", and
 * a week covers a holiday, a broken laptop, and the case the milestone actually
 * tests — a machine asleep over a weekend.
 *
 * Beyond it nothing is lost, which is why this can be short: the gap path
 * delivers current state and backfill repairs the history below on demand. The
 * cost of a short horizon is a gap; the cost of a long one is a table that only
 * grows, on the hottest read path in the system.
 */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** One sweep pass deletes at most this many rows. */
export const SWEEP_BATCH = 5_000;

export interface SweepResult {
  deleted: number;
  /** True when the batch filled, so there is more to do on the next pass. */
  more: boolean;
}

/**
 * Delete one bounded batch of events older than the horizon.
 *
 * BOUNDED, AND NO LONG TRANSACTION. An unbounded `DELETE FROM sync_events WHERE
 * created_at < …` on a table this hot holds locks for as long as it runs and
 * bloats the WAL with one enormous transaction — the classic way a retention
 * job becomes an outage. Each pass is its own statement; a caller loops until
 * `more` is false, yielding between passes.
 *
 * Keyed on `event_id`, not `created_at`. A ULID is time-ordered with a constant
 * prefix, so this is a range over the primary key and needs no second index.
 */
export async function sweepEvents(
  db: Kysely<DB>, now = Date.now(), batch = SWEEP_BATCH,
): Promise<SweepResult> {
  const floor = ulidFloor('evt', now - RETENTION_MS);
  const deleted = await sql<{ count: number }>`
    WITH doomed AS (
      SELECT event_id FROM sync_events
       WHERE event_id < ${floor}
       ORDER BY event_id
       LIMIT ${batch}
    )
    DELETE FROM sync_events
     USING doomed
     WHERE sync_events.event_id = doomed.event_id
  `.execute(db);

  const count = Number(deleted.numAffectedRows ?? 0);
  return { deleted: count, more: count === batch };
}

/**
 * The oldest revision still replayable on a stream, or null if none is.
 *
 * THIS IS THE FUNCTION THE FIRST CRITERION IS ABOUT. Revisions are gapless per
 * stream — every allocation appends exactly one event — so "is rev N+1 still
 * here" is a complete answer to "can this client replay from N".
 *
 * Without it the failure is silent and permanent. Sweep revisions 1 to 500 on a
 * stream whose head is 520, and a client at cursor 100 is within the gap
 * threshold, so it gets a replay: `eventsSince(100)` returns 501 to 520. The
 * client applies 501 against a frontier of 100, finds a hole, stages it, and
 * asks again — for ever. If everything was swept it is worse: an EMPTY replay,
 * `to_rev` equal to the cursor it sent, and a client that concludes nothing has
 * changed while the head runs away from it.
 */
export async function retainedFrom(
  db: Kysely<DB>, stream: Stream,
): Promise<number | null> {
  const row = await db.selectFrom('sync_events')
    .select('stream_rev')
    .where('stream_kind', '=', stream.kind)
    .where('stream_id', '=', stream.id)
    .orderBy('stream_rev')
    .limit(1)
    .executeTakeFirst();
  return row?.stream_rev ?? null;
}

/**
 * Run the sweep on a schedule, draining fully each time.
 *
 * Hourly rather than continuously: nothing depends on an event disappearing
 * promptly, and a job that runs constantly is one more thing competing with the
 * reads that matter. Each tick drains to completion in bounded passes, yielding
 * between them so a large backlog never becomes one long transaction.
 *
 * The FIRST tick is delayed, deliberately. A server that swept on boot would do
 * its heaviest database work at exactly the moment every client is reconnecting
 * after the deploy that restarted it.
 */
export function startRetention(
  db: Kysely<DB>,
  intervalMs = 60 * 60 * 1_000,
  onSwept?: (deleted: number, passes: number) => void,
): () => void {
  let stopped = false;

  const tick = async (): Promise<void> => {
    let deleted = 0;
    let passes = 0;
    try {
      for (;;) {
        if (stopped) return;
        const result = await sweepEvents(db);
        deleted += result.deleted;
        passes++;
        if (!result.more) break;
        // Between passes, so a backlog of a million rows does not monopolise
        // the connection it is running on.
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (deleted > 0) onSwept?.(deleted, passes);
    } catch {
      // A failed sweep is not an incident. Nothing depends on it having run —
      // the worst case is a larger table and, eventually, a client getting a
      // gap where it would have got a replay. The next tick tries again.
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

/**
 * MULTI-NODE FANOUT, written down and NOT built.
 *
 * Today one node holds every connection and fans out in-process, which is why
 * the residue above exists at all. With two nodes an event committed on one has
 * to reach the connections held by the other, and the shape is:
 *
 *   - `LISTEN/NOTIFY` on commit, which fires only if the transaction COMMITS —
 *     that ordering is the whole reason to prefer it over an application-level
 *     bus, because a bus can be told about a write that then rolls back.
 *   - a sweep over events whose `published_at` is null, as the safety net for a
 *     notification lost while a node was restarting.
 *
 * That second half is exactly what the extra columns in the AppSync proposal
 * are for — `published_at`, `publish_attempts`, `next_publish_at`. They earn
 * their place at the moment there is a second node, and not before: carrying
 * them now would be three columns nothing writes and a publisher nothing runs.
 *
 * The trigger is explicit rather than aspirational: **the first time a second
 * server process holds connections.** Availability alone does not force it —
 * two nodes behind a load balancer where only one accepts sockets is still one
 * fanout tier.
 */
export const MULTI_NODE = 'not built — see the comment above' as const;
