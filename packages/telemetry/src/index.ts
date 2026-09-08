// The only surface anything else imports. Nothing outside this package may
// import `@opentelemetry/*` or `pino` directly (OBSERVABILITY.md §8, enforced
// by lint). Swapping the backend is then one file, not a codebase sweep.
import { events, type EventName, type EventFields } from './events.ts';
import { OtlpSink } from './otlp.ts';

export { events, type EventName, type EventFields };
export { OtlpSink } from './otlp.ts';

// ── Metrics ────────────────────────────────────────────────────────────────
// Labels are CLOSED SETS by construction. The 10k active-series cap on the
// Grafana free tier is a cardinality limit, so an unbounded id here would blow
// it instantly (OBSERVABILITY.md §5). These types make that a compile error.
export type Service = 'desktop' | 'server' | 'agents';
export type Result  = 'ok' | 'error';
export type OpKind  = 'send' | 'edit' | 'react' | 'delete' | 'read';

export interface MetricLabels {
  service?: Service;
  result?: Result;
  op?: OpKind;
}

export interface Sink {
  event<N extends EventName>(name: N, fields: EventFields<N>): void;
  count(metric: string, labels?: MetricLabels, by?: number): void;
  gauge(metric: string, value: number, labels?: MetricLabels): void;
  histogram(metric: string, value: number, labels?: MetricLabels): void;
  span<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
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
  async span<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const t0 = performance.now();
    try {
      const out = await fn();
      this.#emit('span', { name, ms: +(performance.now() - t0).toFixed(2), result: 'ok' });
      return out;
    } catch (e) {
      this.#emit('span', { name, ms: +(performance.now() - t0).toFixed(2), result: 'error' });
      throw e;
    }
  }
}

let sink: Sink = new ConsoleSink();
export const setSink = (s: Sink) => { sink = s; };

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
    span: (n, fn) => otlp.span(n, fn),
  };

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
export const count     = (m: string, l?: MetricLabels, by?: number) => sink.count(m, l, by);
export const gauge     = (m: string, v: number, l?: MetricLabels) => sink.gauge(m, v, l);
export const histogram = (m: string, v: number, l?: MetricLabels) => sink.histogram(m, v, l);
export const span      = <T>(n: string, fn: () => Promise<T> | T) => sink.span(n, fn);
