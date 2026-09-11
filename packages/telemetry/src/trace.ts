// Real distributed tracing: W3C trace context, span hierarchy, propagation.
// Step 13 of the sync build plan (docs/SYNC-FLOWS.md §2).
//
// WHAT THIS REPLACES, and why it was not enough. `span(name, fn)` used to time a
// function and emit a log record with a duration. That answers "how long did
// this take on average" and nothing else — it cannot answer the question traces
// exist for, which is "what happened to THIS message, in order, across two
// processes". There was no trace id, no parent, and nothing crossing the socket.
//
// A SPAN IS A LOGICAL OPERATION, NEVER A CONNECTION (OBSERVABILITY.md §4).
// Connection lifecycle — connects, drops, zombie detection — stays events and
// metrics. Tracing every heartbeat would be volume with no question attached.
//
// No `@opentelemetry/sdk-trace`. The wire format is the same either way, and
// this package already hand-rolls OTLP for the same reason: one file to swap.
// What we would gain from the SDK is auto-instrumentation of HTTP, which is
// exactly the layer that is NOT interesting here — the interesting path is a
// frame on a socket, which no auto-instrumentation knows about.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

/** The three fields W3C trace context carries between processes. */
export interface SpanContext {
  /** 32 hex characters. The whole operation, across every process. */
  traceId: string;
  /** 16 hex characters. This step of it. */
  spanId: string;
  sampled: boolean;
}

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

/** A finished span, in the shape the exporter needs. */
export interface FinishedSpan extends SpanContext {
  name: string;
  parentSpanId: string | undefined;
  startMs: number;
  durationMs: number;
  attributes: SpanAttributes;
  events: { name: string; atMs: number; attributes: SpanAttributes }[];
  status: 'ok' | 'error';
  error?: string;
}

interface Active extends SpanContext {
  name: string;
  parentSpanId: string | undefined;
  startMs: number;
  attributes: SpanAttributes;
  events: { name: string; atMs: number; attributes: SpanAttributes }[];
}

/**
 * Where the current span lives.
 *
 * `AsyncLocalStorage` rather than a module-level variable, because every
 * interesting path here is asynchronous and interleaved: two messages being
 * sent at once would otherwise attribute one's database call to the other's
 * span. It survives `await`, which a plain variable does not.
 */
const store = new AsyncLocalStorage<Active>();

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

export const newTraceId = (): string => hex(16);
export const newSpanId = (): string => hex(8);

/** The span currently running, if anything started one. */
export function currentSpan(): SpanContext | undefined {
  const active = store.getStore();
  if (!active) return undefined;
  return { traceId: active.traceId, spanId: active.spanId, sampled: active.sampled };
}

/**
 * Serialise the current span for the wire.
 *
 * `00-<trace>-<span>-<flags>`. OTel propagates this through HTTP headers by
 * itself; a WebSocket provides nothing, so a frame has to carry it explicitly —
 * which is why `traceparent` is a reserved key on every frame envelope
 * (OBSERVABILITY.md §4).
 */
export function traceparent(ctx = currentSpan()): string | undefined {
  if (!ctx) return undefined;
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? '01' : '00'}`;
}

/**
 * Read a `traceparent` off the wire.
 *
 * Returns undefined for anything malformed rather than throwing. A header from
 * another system — or a client three months old — must never be able to fail a
 * request: the worst outcome of a bad one is a trace that starts here instead
 * of continuing, which is a missing link rather than an error.
 */
export function parseTraceparent(header: string | undefined): SpanContext | undefined {
  if (!header) return undefined;
  const parts = header.split('-');
  if (parts.length !== 4) return undefined;
  const [version, traceId, spanId, flags] = parts as [string, string, string, string];
  if (version !== '00') return undefined;
  if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === '0'.repeat(32)) return undefined;
  if (!/^[0-9a-f]{16}$/.test(spanId) || spanId === '0'.repeat(16)) return undefined;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export interface SpanOptions {
  attributes?: SpanAttributes;
  /**
   * Continue a trace started elsewhere. The new span becomes a child of this.
   *
   * How a client's "user pressed send" and the server's "assign an ordinal"
   * end up in ONE trace rather than two that happen to be near each other in
   * time.
   */
  parent?: SpanContext | undefined;
  /** Force a root even inside another span. Used by long-lived background work. */
  root?: boolean;
}

/** Called with each finished span. Set by the package index. */
let record: (span: FinishedSpan) => void = () => {};
export const onSpanEnd = (fn: (span: FinishedSpan) => void): void => { record = fn; };

/** Mint the span and the function that reports it. Shared by both entry points. */
function begin(name: string, opts: SpanOptions): {
  active: Active;
  finish: (status: 'ok' | 'error', error?: string) => void;
} {
  const parent = opts.root ? undefined : (opts.parent ?? currentSpan());
  const active: Active = {
    traceId: parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    parentSpanId: parent?.spanId,
    sampled: parent?.sampled ?? true,
    name,
    startMs: Date.now(),
    attributes: { ...opts.attributes },
    events: [],
  };

  const started = performance.now();
  let ended = false;
  const finish = (status: 'ok' | 'error', error?: string): void => {
    // Idempotent, because a span with a lifetime longer than a function call
    // has more than one way to end: an ack, a nack, a socket that went away.
    // Ending twice would report the same operation as two, and the second
    // duration would be measured from the same start.
    if (ended) return;
    ended = true;
    record({
      traceId: active.traceId, spanId: active.spanId, sampled: active.sampled,
      name: active.name, parentSpanId: active.parentSpanId,
      startMs: active.startMs,
      durationMs: +(performance.now() - started).toFixed(3),
      attributes: active.attributes, events: active.events,
      status, ...(error !== undefined ? { error } : {}),
    });
  };

  return { active, finish };
}

/**
 * Run `fn` inside a span.
 *
 * The span ends when `fn` settles — including when it throws, which is recorded
 * as a failed span rather than swallowed. A trace that silently omits its
 * failures is worse than no trace: it shows a path that looks complete.
 */
export async function startSpan<T>(
  name: string, fn: () => Promise<T> | T, opts: SpanOptions = {},
): Promise<T> {
  const { active, finish } = begin(name, opts);
  return store.run(active, async () => {
    try {
      const out = await fn();
      finish('ok');
      return out;
    } catch (e) {
      // The MESSAGE only, never the thrown value. An error object can carry
      // anything a caller put on it, and a chat product's most sensitive data
      // is one careless field away from a span attribute (OBSERVABILITY.md §6).
      finish('error', e instanceof Error ? e.message : 'error');
      throw e;
    }
  });
}

/** A span whose end is somewhere else. */
export interface OpenSpan extends SpanContext {
  readonly name: string;
  annotate(attributes: SpanAttributes): void;
  mark(name: string, attributes?: SpanAttributes): void;
  /** Run `fn` with this span active, so anything it starts becomes a child. */
  run<T>(fn: () => T): T;
  /** Report it. Calling twice does nothing the second time. */
  end(status?: 'ok' | 'error', error?: string): void;
}

/**
 * Start a span that does NOT end when the function that made it returns.
 *
 * The one shape `startSpan` cannot express, and the shape the interesting
 * operations here actually have. "Sending a message" begins when somebody
 * presses return and ends when an `ack` arrives over a socket — possibly after
 * a reconnect, possibly minutes later if the laptop was shut. There is no
 * function whose body is that operation, so there is no callback to wrap.
 *
 * The cost is that the caller owns the ending, and a caller that forgets leaves
 * a span that is never reported. That is why every holder of one of these is a
 * map keyed by something that settles — an op id, a connection — and why the
 * teardown path ends what it is still holding (invariant 54).
 */
export function openSpan(name: string, opts: SpanOptions = {}): OpenSpan {
  const { active, finish } = begin(name, opts);
  return {
    traceId: active.traceId,
    spanId: active.spanId,
    sampled: active.sampled,
    name: active.name,
    annotate: (attributes) => { Object.assign(active.attributes, attributes); },
    mark: (markName, attributes = {}) => {
      active.events.push({ name: markName, atMs: Date.now(), attributes });
    },
    run: (fn) => store.run(active, fn),
    end: (status = 'ok', error) => { finish(status, error); },
  };
}

/**
 * Annotate the span currently running.
 *
 * Ids are permitted here and forbidden as metric labels, and the difference is
 * not arbitrary: traces are indexed for high cardinality and metrics are not.
 * This is what makes "why did THIS person's message hang" answerable at all.
 */
export function annotate(attributes: SpanAttributes): void {
  const active = store.getStore();
  if (!active) return;
  Object.assign(active.attributes, attributes);
}

/**
 * Mark a moment inside a span.
 *
 * For the points that matter within one operation but are not operations
 * themselves — "queued", "socket write", "ack received". A child span for each
 * would triple the span count to record three timestamps.
 */
export function mark(name: string, attributes: SpanAttributes = {}): void {
  const active = store.getStore();
  if (!active) return;
  active.events.push({ name, atMs: Date.now(), attributes });
}

/**
 * Run `fn` outside any span.
 *
 * For work that is triggered by a request but does not belong to it — a
 * background sweep kicked off from a handler, say. Without this the sweep would
 * inherit the request's trace and make one message's span tree contain an hour
 * of retention work.
 */
export function detached<T>(fn: () => T): T {
  return store.exit(fn);
}
