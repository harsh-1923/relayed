// The client half of the ingest path (OBSERVABILITY.md §3).
//
// A packaged build has no collector to talk to and must not be given one: an
// ingest credential inside a distributable binary is trivially extractable, and
// exporting straight from a laptop leaves nowhere to scrub. So records go to our
// own server, over the session that already exists, and the server validates
// them against the same catalogue before anything reaches Grafana.
//
// BOUNDED AND LOSSY, LIKE EVERY TELEMETRY BUFFER HERE (§7). The outbox and this
// need opposite failure behaviour: a message must survive at any cost, and a
// metric must never delay one. When the buffer is full the OLDEST records go,
// not the newest — a full buffer usually means something is wrong right now,
// and the records describing it are the ones worth keeping.
//
// WHAT IS DROPPED IS COUNTED, and the count travels with the next batch. A
// dashboard that cannot say whether its numbers are complete is a dashboard
// that lies quietly: a load run once discarded 86% of its telemetry while every
// shape still looked right.
import { serverUrl } from './config.ts';

export interface Record_ {
  kind: 'event' | 'count' | 'histogram';
  name: string;
  value?: number;
  fields?: Record<string, unknown>;
  labels?: Record<string, string>;
}

/** Roughly a minute of a busy client, and small enough to post in one go. */
const MAX_BUFFER = 2_000;
const FLUSH_MS = 30_000;
/** Matches the server's own ceiling, so a batch is never truncated in transit. */
const MAX_BATCH = 500;

export interface UploaderDeps {
  /** The current access token, or null when signed out. Resolved per flush. */
  token(): string | null;
  fetchImpl?: typeof globalThis.fetch;
}

export class TelemetryUploader {
  #buffer: Record_[] = [];
  #dropped = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #deps: UploaderDeps;

  constructor(deps: UploaderDeps) {
    this.#deps = deps;
  }

  add(record: Record_): void {
    if (this.#buffer.length >= MAX_BUFFER) {
      // Oldest out. See the header: the newest records describe the present.
      this.#buffer.shift();
      this.#dropped++;
    }
    this.#buffer.push(record);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Post one batch. Never throws, and never reports a failure to the caller.
   *
   * ON FAILURE THE BATCH IS DISCARDED rather than retried. A retry queue for
   * telemetry is a queue that grows while the network is down and competes with
   * the outbox for the first bytes when it returns — and the outbox carries
   * things a person typed. The loss is counted instead.
   */
  async flush(): Promise<number> {
    const token = this.#deps.token();
    if (!token || this.#buffer.length === 0) return 0;

    const batch = this.#buffer.splice(0, MAX_BATCH);
    const dropped = this.#dropped;
    this.#dropped = 0;

    try {
      const f = this.#deps.fetchImpl ?? globalThis.fetch;
      const res = await f(`${serverUrl()}/telemetry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ records: batch, dropped }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) { this.#dropped += batch.length; return 0; }
      return batch.length;
    } catch {
      // Offline, a proxy, a 500. The records are gone and the count says so.
      this.#dropped += batch.length;
      return 0;
    }
  }

  /** For the tests, and for a dashboard that asks how far behind this client is. */
  get depth(): number { return this.#buffer.length; }
  get droppedCount(): number { return this.#dropped; }
}
