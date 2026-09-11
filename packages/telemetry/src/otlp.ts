// OTLP/HTTP sink. Emits catalogued events as OTel log records so they land in
// Loki and are visible in Grafana (OBSERVABILITY.md §10).
//
// Hand-rolled OTLP JSON rather than the OTel SDK: @opentelemetry/sdk-logs is
// still 0.x, and this is the signal we touch most. Same wire format either way,
// so swapping in the SDK later changes only this file.
//
// DEV ONLY as written — it posts straight to a collector. Production routes
// client telemetry through our own server so it can be scrubbed and validated
// against the catalogue before leaving the machine (OBSERVABILITY.md §3).
import type { EventName, EventFields } from './events.ts';
import type { MetricLabels, Sink } from './index.ts';
import type { FinishedSpan } from './trace.ts';

const nano = () => String(Date.now() * 1e6);

type AnyValue = { stringValue: string } | { intValue: string } | { boolValue: boolean } | { doubleValue: number };
const value = (v: unknown): AnyValue =>
  typeof v === 'boolean' ? { boolValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
  : { stringValue: String(v) };
const attrs = (o: Record<string, unknown>) =>
  Object.entries(o).map(([key, v]) => ({ key, value: value(v) }));

/** Drop undefined, so an optional attribute is absent rather than "undefined". */
const clean = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export interface OtlpOptions {
  endpoint?: string;
  service: 'desktop' | 'server' | 'agents';
  /** Bounded, lossy. Telemetry must never delay user data (OBSERVABILITY.md §7). */
  maxQueue?: number;
  flushMs?: number;
}

/**
 * How much the buffer holds, and how often it empties.
 *
 * THESE NUMBERS WERE 500 AND 5000, and a load run found what that means: 100
 * records a second, against a run producing three and a half thousand. It
 * dropped **86% of everything** and said nothing, so every count on every
 * dashboard was a twelfth of the truth while the shapes still looked right —
 * which is the most dangerous way for instrumentation to be wrong.
 *
 * Raised to a window a real burst fits inside. It is still bounded and still
 * lossy on purpose (§7: the telemetry buffer and the outbox need OPPOSITE
 * failure behaviour) — but now overflow is COUNTED, so a dashboard can say
 * when it is incomplete instead of quietly under-reporting.
 *
 * The real fix is aggregation: one record per observation is the wrong shape
 * for a metric, and OTLP metrics on `/v1/metrics` carry pre-aggregated series
 * instead. That is §3's ingest work. Until it lands, this is the honest
 * stopgap — a bigger window and a visible drop count.
 */
const MAX_QUEUE = 20_000;
const FLUSH_MS = 2_000;

export class OtlpSink implements Sink {
  #queue: object[] = [];
  #spans: object[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #logsEndpoint: string;
  readonly #tracesEndpoint: string;
  readonly #resource: object;
  readonly #max: number;
  /** Records the buffer refused since the last flush, by signal. */
  #dropped = { logs: 0, spans: 0 };

  constructor(opts: OtlpOptions) {
    const base = opts.endpoint ?? 'http://localhost:4318';
    this.#logsEndpoint = `${base}/v1/logs`;
    // A SEPARATE endpoint, because traces are a different OTLP signal — posting
    // them to /v1/logs would store span-shaped log lines that no trace view can
    // read, which is what the old `span()` was doing.
    this.#tracesEndpoint = `${base}/v1/traces`;
    this.#max = opts.maxQueue ?? MAX_QUEUE;
    this.#resource = { attributes: attrs({ 'service.name': `relayed-${opts.service}` }) };
    this.#timer = setInterval(() => void this.flush(), opts.flushMs ?? FLUSH_MS);
    this.#timer.unref?.();
  }

  #push(record: object): void {
    // Drop the OLDEST on overflow. Losing telemetry is acceptable; blocking or
    // growing without bound is not — but a SILENT drop is not acceptable, which
    // is what this used to be.
    if (this.#queue.length >= this.#max) { this.#queue.shift(); this.#dropped.logs++; }
    this.#queue.push(record);
  }

  event<N extends EventName>(name: N, fields: EventFields<N>): void {
    this.#push({
      timeUnixNano: nano(), severityNumber: 9, severityText: 'INFO',
      body: { stringValue: name },
      attributes: attrs({ 'event.name': name, ...(fields as Record<string, unknown>) }),
    });
  }

  #metric(kind: string, metric: string, v: number, labels?: MetricLabels): void {
    this.#push({
      timeUnixNano: nano(), severityNumber: 9, severityText: 'INFO',
      body: { stringValue: `${kind} ${metric}` },
      attributes: attrs({ 'metric.name': metric, 'metric.kind': kind, 'metric.value': v, ...labels }),
    });
  }
  count(m: string, l?: MetricLabels, by = 1) { this.#metric('count', m, by, l); }
  gauge(m: string, v: number, l?: MetricLabels) { this.#metric('gauge', m, v, l); }
  histogram(m: string, v: number, l?: MetricLabels) { this.#metric('histogram', m, v, l); }

  /**
   * A finished span, as OTLP.
   *
   * Bounded the same way logs are, and dropped oldest-first on overflow: a burst
   * of tracing must never delay a message. That is the whole of §7's rule —
   * the telemetry buffer and the outbox need OPPOSITE failure behaviour.
   */
  recordSpan(span: FinishedSpan): void {
    if (!span.sampled) return;
    if (this.#spans.length >= this.#max) { this.#spans.shift(); this.#dropped.spans++; }
    const startNano = BigInt(span.startMs) * 1_000_000n;
    const endNano = startNano + BigInt(Math.round(span.durationMs * 1_000_000));
    this.#spans.push({
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      name: span.name,
      kind: 1,
      startTimeUnixNano: String(startNano),
      endTimeUnixNano: String(endNano),
      attributes: attrs(clean(span.attributes)),
      events: span.events.map(event => ({
        timeUnixNano: String(BigInt(event.atMs) * 1_000_000n),
        name: event.name,
        attributes: attrs(clean(event.attributes)),
      })),
      // 0 unset, 1 ok, 2 error — the OTLP enum.
      status: span.status === 'error'
        ? { code: 2, message: span.error ?? 'error' }
        : { code: 1 },
    });
  }

  async flush(): Promise<void> {
    const logRecords = this.#queue.splice(0, this.#queue.length);
    const spans = this.#spans.splice(0, this.#spans.length);

    // ADDED AT FLUSH TIME, so it cannot itself be dropped by the buffer it is
    // reporting on — a drop counter that overflows is worse than none, because
    // it reads as healthy. Emitted only when something was actually lost, so
    // absence is health and the alert is `> 0` (§9).
    const lost = this.#dropped;
    this.#dropped = { logs: 0, spans: 0 };
    if (lost.logs > 0 || lost.spans > 0) {
      logRecords.push({
        timeUnixNano: nano(), severityNumber: 13, severityText: 'WARN',
        body: { stringValue: 'telemetry.dropped' },
        attributes: attrs({
          'metric.name': 'telemetry.dropped', 'metric.kind': 'count',
          'metric.value': lost.logs + lost.spans,
          signal: lost.spans > lost.logs ? 'spans' : 'records',
        }),
      });
    }

    // Both posts are attempted even if one fails. A collector rejecting traces
    // must not also cost us the logs — and logs are the signal that would say
    // why it rejected them.
    await Promise.all([
      logRecords.length > 0 ? this.#post(this.#logsEndpoint, {
        resourceLogs: [{ resource: this.#resource,
          scopeLogs: [{ scope: { name: 'relayed' }, logRecords }] }],
      }) : Promise.resolve(),
      spans.length > 0 ? this.#post(this.#tracesEndpoint, {
        resourceSpans: [{ resource: this.#resource,
          scopeSpans: [{ scope: { name: 'relayed' }, spans }] }],
      }) : Promise.resolve(),
    ]);
  }

  async #post(endpoint: string, body: object): Promise<void> {
    try {
      await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // A collector that is down must never surface as an app error. The
      // records are simply lost, which is the contract for telemetry.
    }
  }

  stop(): void { if (this.#timer) clearInterval(this.#timer); }
}
