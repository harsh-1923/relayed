// The renderer's telemetry door (OBSERVABILITY.md §3).
//
// The renderer does NOT hold an SDK. One SDK, one buffer, one exporter, in the
// sync process — a second one here would mean a second flush timer subject to
// Chromium's renderer throttling (DESIGN.md §13.9), which is the one place a
// timer cannot be trusted. So this forwards over the port that already exists
// and the sync process does the emitting.
//
// The CATALOGUE still applies at compile time: the types below come from
// @relayed/telemetry, so an undeclared event or a wrong field type fails to
// build here exactly as it does in the sync process. The import is type-only,
// which is what keeps the SDK out of the renderer bundle — and the boundary
// rule `renderer/no-telemetry-sdk` keeps it that way.
import type {
  EventName, EventFields, MetricName, MetricLabelsFor,
} from '@relayed/telemetry/catalogue';
import { bridge } from './ipc';

/**
 * The telemetry buffer is not the outbox (OBSERVABILITY.md §7).
 *
 * A queued message is user data and is never dropped. A telemetry record is
 * not: if the sync process stops draining, this drops rather than growing, and
 * says so. The two must not share a mechanism, because sharing one means either
 * a backed-up outbox delays telemetry or — far worse — telemetry volume delays
 * somebody's message.
 */
const MAX_INFLIGHT = 200;
let inflight = 0;
let dropped = 0;

/**
 * The wire shape, mirroring the `telemetry.emit` op. Typed rather than a loose
 * record so the bridge's overload can still see which op this is.
 */
type Record_ =
  | { kind: 'event'; name: string; fields: Readonly<Record<string, string | number | boolean>> }
  | { kind: 'count'; name: string; labels: Readonly<Record<string, string>> }
  | { kind: 'histogram'; name: string; value: number; labels: Readonly<Record<string, string>> };

function post(record: Record_): void {
  const api = bridge();
  // No bridge at all: `pnpm ui` runs the renderer standalone for layout work.
  // Silently no-op rather than buffering for a sink that will never arrive.
  if (!api) return;
  if (inflight >= MAX_INFLIGHT) { dropped += 1; return; }

  inflight += 1;
  // Reported rather than counted here, for the same reason the preload reports
  // its stale drops: the SDK lives on the other side of the port.
  const carried = dropped;
  dropped = 0;
  void api.query('telemetry.emit', { ...record, dropped: carried })
    .catch(() => { /* a lost telemetry record must never surface to a user */ })
    .finally(() => { inflight -= 1; });
}

/** Emit a catalogued event. Ids are permitted here; on metrics they are not. */
export const emit = <N extends EventName>(name: N, fields: EventFields<N>): void =>
  post({ kind: 'event', name, fields: fields as Readonly<Record<string, string | number | boolean>> });

export function count<N extends MetricName>(
  metric: N,
  ...rest: MetricLabelsFor<N> extends Record<string, never>
    ? [] : [labels: MetricLabelsFor<N>]
): void {
  post({ kind: 'count', name: metric, labels: (rest[0] ?? {}) as Readonly<Record<string, string>> });
}

export function histogram<N extends MetricName>(
  metric: N, value: number,
  ...rest: MetricLabelsFor<N> extends Record<string, never>
    ? [] : [labels: MetricLabelsFor<N>]
): void {
  post({ kind: 'histogram', name: metric, value,
         labels: (rest[0] ?? {}) as Readonly<Record<string, string>> });
}

/**
 * Report the frame in which the router first painted.
 *
 * The timestamp is taken here and the DURATION computed in the sync process,
 * which is the only side that knows when the app started. Same machine, same
 * wall clock, so the subtraction is safe — and it keeps a boot constant out of
 * the renderer, where it would be one more thing to keep in step.
 */
export const reportFirstPaint = (): void => {
  const api = bridge();
  if (!api) return;
  void api.query('telemetry.firstPaint', { at: Date.now() }).catch(() => {});
};
