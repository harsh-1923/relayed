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

const nano = () => String(Date.now() * 1e6);

type AnyValue = { stringValue: string } | { intValue: string } | { boolValue: boolean } | { doubleValue: number };
const value = (v: unknown): AnyValue =>
  typeof v === 'boolean' ? { boolValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
  : { stringValue: String(v) };
const attrs = (o: Record<string, unknown>) =>
  Object.entries(o).map(([key, v]) => ({ key, value: value(v) }));

export interface OtlpOptions {
  endpoint?: string;
  service: 'desktop' | 'server' | 'agents';
  /** Bounded, lossy. Telemetry must never delay user data (OBSERVABILITY.md §7). */
  maxQueue?: number;
  flushMs?: number;
}

export class OtlpSink implements Sink {
  #queue: object[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #endpoint: string;
  readonly #resource: object;
  readonly #max: number;

  constructor(opts: OtlpOptions) {
    this.#endpoint = (opts.endpoint ?? 'http://localhost:4318') + '/v1/logs';
    this.#max = opts.maxQueue ?? 500;
    this.#resource = { attributes: attrs({ 'service.name': `relayed-${opts.service}` }) };
    this.#timer = setInterval(() => void this.flush(), opts.flushMs ?? 5000);
    this.#timer.unref?.();
  }

  #push(record: object): void {
    // Drop the OLDEST on overflow. Losing telemetry is acceptable; blocking or
    // growing without bound is not.
    if (this.#queue.length >= this.#max) this.#queue.shift();
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

  async span<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const t0 = performance.now();
    try {
      const out = await fn();
      this.#metric('span', name, +(performance.now() - t0).toFixed(2), { result: 'ok' });
      return out;
    } catch (e) {
      this.#metric('span', name, +(performance.now() - t0).toFixed(2), { result: 'error' });
      throw e;
    }
  }

  async flush(): Promise<void> {
    if (this.#queue.length === 0) return;
    const logRecords = this.#queue.splice(0, this.#queue.length);
    try {
      await fetch(this.#endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceLogs: [{ resource: this.#resource,
          scopeLogs: [{ scope: { name: 'relayed' }, logRecords }] }] }),
      });
    } catch {
      // A collector that is down must never surface as an app error. The
      // records are simply lost, which is the contract for telemetry.
    }
  }

  stop(): void { if (this.#timer) clearInterval(this.#timer); }
}
