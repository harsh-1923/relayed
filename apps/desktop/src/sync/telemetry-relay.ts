// The runtime boundary on renderer telemetry (OBSERVABILITY.md §8).
//
// The renderer is held to the catalogue at compile time already. This is the
// check that still holds when the caller is not the renderer we built — the
// same argument §8 makes for the server validating client telemetry: a
// catalogue enforced only by types is enforced only for people who ran the
// compiler.
//
// Nothing here throws. A telemetry record must never be able to fail a UI
// action, so an unrecognised one is dropped and the caller is none the wiser.
import { events, metrics } from '@relayed/telemetry/catalogue';

/** Where a validated record goes. Injected so this file can be tested alone. */
export interface RelaySink {
  event(name: string, fields: Record<string, unknown>): void;
  count(name: string, labels: Record<string, string>): void;
  histogram(name: string, value: number, labels: Record<string, string>): void;
  /** Records the renderer discarded before this one (OBSERVABILITY.md §7). */
  dropped(count: number): void;
}

/** Applied a record, or dropped it. Returned for the tests, ignored in production. */
export type RelayOutcome = 'event' | 'count' | 'histogram' | 'dropped';

export function relayTelemetry(params: unknown, sink: RelaySink): RelayOutcome {
  const record = params as {
    kind?: unknown; name?: unknown; value?: unknown; dropped?: unknown;
    fields?: unknown; labels?: unknown;
  } | null | undefined;
  if (!record || typeof record !== 'object') return 'dropped';

  // Counted before the record is validated: a renderer that dropped telemetry
  // and then sent something malformed still dropped telemetry, and that is the
  // half worth knowing about.
  if (typeof record.dropped === 'number' && record.dropped > 0) sink.dropped(record.dropped);

  const name = typeof record.name === 'string' ? record.name : '';
  const fields = asRecord(record.fields);
  const labels = asLabels(record.labels);

  if (record.kind === 'event') {
    if (!(name in events)) return 'dropped';
    sink.event(name, fields);
    return 'event';
  }
  if (record.kind === 'count') {
    if (!(name in metrics)) return 'dropped';
    sink.count(name, labels);
    return 'count';
  }
  if (record.kind === 'histogram') {
    if (!(name in metrics)) return 'dropped';
    if (typeof record.value !== 'number' || !Number.isFinite(record.value)) return 'dropped';
    sink.histogram(name, record.value, labels);
    return 'histogram';
  }
  return 'dropped';
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/**
 * Label values are stringified rather than rejected on type.
 *
 * The catalogue's closed unions are the real guard and they are enforced where
 * the call is written. Here the concern is only that nothing structural — an
 * object, an array — reaches a label position and becomes an unbounded series.
 */
function asLabels(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = String(raw);
    }
  }
  return out;
}
