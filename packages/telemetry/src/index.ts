// The only surface anything else imports. Nothing outside this package may
// import `@opentelemetry/*` or `pino` directly (OBSERVABILITY.md §8, enforced
// by lint). Swapping the backend is then one file, not a codebase sweep.
import { events, type EventName, type EventFields } from './events.ts';
import { metrics, type MetricName, type MetricLabelsFor } from './metrics.ts';
import { OtlpSink } from './otlp.ts';
import { startSpan, onSpanEnd, type FinishedSpan, type SpanOptions } from './trace.ts';

export { events, type EventName, type EventFields };
export {
  startSpan, openSpan, annotate, mark, detached, traceparent, parseTraceparent,
  currentSpan, newTraceId, newSpanId,
  type SpanContext, type SpanAttributes, type FinishedSpan, type SpanOptions,
  type OpenSpan,
} from './trace.ts';
export {
  metrics, labelValues,
  type MetricName, type MetricLabelsFor, type LabelValues, type LabelName,
} from './metrics.ts';
export { OtlpSink } from './otlp.ts';

// ── Metrics ────────────────────────────────────────────────────────────────
// Labels are CLOSED SETS by construction, declared per metric in metrics.ts.
// The 10k active-series cap is a cardinality limit, so an unbounded id here
// would blow it instantly (OBSERVABILITY.md §5) — these types make passing one
// a compile error rather than a surprise on the bill.
export type Service = 'desktop' | 'server' | 'agents';

/** Loose shape for the transport. Call sites go through the typed helpers. */
export type MetricLabels = Record<string, string | number | boolean>;

export interface Sink {
  event<N extends EventName>(name: N, fields: EventFields<N>): void;
  count(metric: string, labels?: MetricLabels, by?: number): void;
  gauge(metric: string, value: number, labels?: MetricLabels): void;
  histogram(metric: string, value: number, labels?: MetricLabels): void;
  /** A finished span. Sinks that do not trace may ignore it. */
  recordSpan?(span: FinishedSpan): void;
}

/** Development sink. Replaced by the OTLP/pino sink in Phase 2. */
class ConsoleSink implements Sink {
  #emit(kind: string, payload: unknown) {
    // The one permitted console call in the codebase: this IS the log sink.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ t: Date.now(), kind, ...(payload as object) }));
  }
  event<N extends EventName>(name: N, fields: EventFields<N>) {
    this.#emit('event', { name, ...fields });
  }
  count(metric: string, labels?: MetricLabels, by = 1) {
    this.#emit('count', { metric, by, ...labels });
  }
  gauge(metric: string, value: number, labels?: MetricLabels) {
    this.#emit('gauge', { metric, value, ...labels });
  }
  histogram(metric: string, value: number, labels?: MetricLabels) {
    this.#emit('histogram', { metric, value, ...labels });
  }
  recordSpan(span: FinishedSpan) {
    // One line per span in a dev terminal, with the trace id — which is what
    // makes "show me everything for this message" a grep rather than a query.
    this.#emit('span', {
      name: span.name, ms: span.durationMs, result: span.status,
      trace: span.traceId, span: span.spanId, parent: span.parentSpanId,
      ...span.attributes,
    });
  }
}

let sink: Sink = new ConsoleSink();
export const setSink = (s: Sink) => { sink = s; onSpanEnd(sp => { sink.recordSpan?.(sp); }); };

// The default sink traces to the console, so a dev terminal shows span lines
// without a collector running.
onSpanEnd(sp => { sink.recordSpan?.(sp); });

/**
 * Send events to a local OTLP collector as well as the console, when one is
 * configured. Dev convenience — production routes through our own server
 * (OBSERVABILITY.md §3).
 *
 * SYNCHRONOUS on purpose. An async setup loses every event emitted before it
 * resolves, and the most interesting ones — migrations, boot timing — happen in
 * the first milliseconds. That was a real bug: only 1 of 3 boot events reached
 * Loki.
 */
export function useOtlpIfConfigured(service: 'desktop' | 'server' | 'agents'): OtlpSink | null {
  const endpoint = globalThis.process?.env?.['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (!endpoint) return null;
  const otlp = new OtlpSink({ endpoint, service });
  const console_ = sink;
  // Tee: the console line stays useful in a dev terminal while Grafana gets
  // the structured copy.
  sink = {
    event: (n, f) => { console_.event(n, f); otlp.event(n, f); },
    count: (m, l, by) => { console_.count(m, l, by); otlp.count(m, l, by); },
    gauge: (m, v, l) => { console_.gauge(m, v, l); otlp.gauge(m, v, l); },
    histogram: (m, v, l) => { console_.histogram(m, v, l); otlp.histogram(m, v, l); },
    recordSpan: (sp) => { console_.recordSpan?.(sp); otlp.recordSpan(sp); },
  };
  onSpanEnd(sp => { sink.recordSpan?.(sp); });

  // Anything still queued at exit is lost otherwise — and shutdown is exactly
  // when you want the last events.
  const flush = () => { void otlp.flush(); };
  globalThis.process?.once?.('exit', flush);
  globalThis.process?.once?.('SIGTERM', flush);
  globalThis.process?.once?.('SIGINT', flush);
  return otlp;
}

/**
 * Emit a catalogued event. The name must exist in `events`, and the fields must
 * match its spec — so there is no argument position where a message body could
 * be passed. That is the privacy control, not a guideline (OBSERVABILITY.md §6).
 */
export const emit = <N extends EventName>(name: N, fields: EventFields<N>) => sink.event(name, fields);
/**
 * Record a catalogued metric. The name must exist in `metrics`, and the labels
 * must be exactly the closed set it declares — so `actor_id` cannot be passed
 * at any argument position, and a cardinality explosion is a compile error
 * rather than something discovered on the bill (OBSERVABILITY.md §5).
 *
 * A metric with no labels takes none: `count('auth.stale')`.
 */
export function count<N extends MetricName>(
  metric: N, ...rest: MetricLabelsFor<N> extends Record<string, never>
    ? [by?: number] : [labels: MetricLabelsFor<N>, by?: number]
): void {
  const [a, b] = rest as [unknown, number | undefined];
  if (typeof a === 'number' || a === undefined) sink.count(metric, undefined, a ?? 1);
  else sink.count(metric, a as MetricLabels, b ?? 1);
}

export function histogram<N extends MetricName>(
  metric: N, value: number,
  ...rest: MetricLabelsFor<N> extends Record<string, never>
    ? [] : [labels: MetricLabelsFor<N>]
): void {
  sink.histogram(metric, value, rest[0] as MetricLabels | undefined);
}

export function gauge<N extends MetricName>(
  metric: N, value: number,
  ...rest: MetricLabelsFor<N> extends Record<string, never>
    ? [] : [labels: MetricLabelsFor<N>]
): void {
  sink.gauge(metric, value, rest[0] as MetricLabels | undefined);
}

/**
 * Run an operation inside a span.
 *
 * A REAL span now, not a timer: it carries a trace id, a parent, and a context
 * that survives `await`, so two messages sent at once do not attribute one's
 * database call to the other. Ids are permitted here and forbidden as metric
 * labels — traces are indexed for high cardinality and metrics are not — which
 * is what makes "why did THIS person's message hang" answerable at all (§5).
 */
export const span = <T>(
  n: string, fn: () => Promise<T> | T, opts?: SpanOptions,
): Promise<T> => startSpan(n, fn, opts);

/** Metric names, for anything that needs to enumerate them (dashboards, tests). */
export const metricNames = Object.keys(metrics) as MetricName[];
