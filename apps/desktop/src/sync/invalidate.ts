// Telling renderers that something they may be reading has changed.
//
// The FACT, never the rows. Pushing payloads would make the renderer maintain a
// mirror of the data, which is precisely the client-side authoritative state
// that putting the database in this process exists to remove (DESIGN.md §11.2).
//
// Extracted from index.ts because the coalescing below is ordering logic, and
// ordering logic that cannot be tested directly gets tested by a user.

/** Sends one flushed batch to every attached renderer. */
export type Broadcast = (batch: { invalidation: number; topics: string[] }) => void;

export type Invalidate = (topics: readonly string[]) => void;

/**
 * Collects topics across the current synchronous run and emits ONE push.
 *
 * A write loop must not produce a push per row. Phase 2's catch-up lands in
 * ~200-row transactions with a yield between them (DESIGN.md §11.4), and that
 * yield is where this flushes — one push per batch, whatever the batch held.
 *
 * `schedule` is injectable only so a test can flush on demand; production uses
 * a microtask, which runs at the end of the current synchronous execution.
 */
export function createInvalidator(
  broadcast: Broadcast,
  schedule: (flush: () => void) => void = queueMicrotask,
): Invalidate {
  let pending: Set<string> | null = null;
  /**
   * Identifies one flushed batch, so the write that caused it and the reads it
   * woke can be found together across two processes (OBSERVABILITY.md §10b).
   * Per process and monotonic — enough to correlate a session, and replaced by
   * `traceparent` in the frame envelope once there is a socket to carry one.
   */
  let nextInvalidation = 1;

  return (topics) => {
    if (topics.length === 0) return;
    if (pending === null) {
      pending = new Set();
      schedule(() => {
        const flushing = pending;
        pending = null;
        if (!flushing || flushing.size === 0) return;
        broadcast({ invalidation: nextInvalidation++, topics: [...flushing] });
      });
    }
    for (const changed of topics) pending.add(changed);
  };
}
