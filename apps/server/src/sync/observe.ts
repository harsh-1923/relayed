// What the sync engine reports, server side — step 13 of the build plan.
//
// ONE DISPATCHER RATHER THAN CALLS SPRINKLED THROUGH THE ENGINE. The socket
// already had a single `note(name, detail)` seam at every point worth a marker,
// carrying the comment "wired to telemetry in the marker pass". This is that
// pass, and turning the seam into the wiring keeps every one of those call
// sites a single line saying what happened rather than two saying what happened
// and where to report it.
//
// The other half of the trade is that this file is a second place a name can be
// wrong — a typo here is a marker that silently goes nowhere. `observe.test.ts`
// closes that: it greps the engine for every name it can emit and fails on any
// this switch does not handle.
//
// The names are also, deliberately, not the metric names. A note says what
// HAPPENED (`sync.socket.read_timeout`); a metric says what is COUNTED
// (`ws.closed{close=read_timeout}`). Collapsing nine causes into one counter
// with a closed label is the whole reason the cardinality budget survives.
import { count, gauge, histogram, emit } from '@relayed/telemetry';

/** Read one field out of an untyped detail bag. */
const int = (detail: Record<string, unknown>, key: string): number =>
  typeof detail[key] === 'number' ? detail[key] : 0;
const str = (detail: Record<string, unknown>, key: string): string =>
  typeof detail[key] === 'string' ? detail[key] : 'unknown';

/**
 * Record one engine note.
 *
 * Never throws, and that is deliberate rather than defensive: this runs inside
 * frame handling, and an instrumentation bug that could close a socket would be
 * a worse outage than the thing it was measuring.
 */
export function observe(name: string, detail: Record<string, unknown> = {}): void {
  try { dispatch(name, detail); } catch { /* telemetry never breaks the engine */ }
}

function dispatch(name: string, detail: Record<string, unknown>): void {
  switch (name) {
    // ── the connection ──────────────────────────────────────────────────────
    case 'sync.socket.connected':
      gauge('ws.sessions', int(detail, 'sessions'));
      return;
    case 'sync.socket.gone':
      // Every close path runs through here, including the ones that are just a
      // client quitting. `close` is what separates a deploy from an auth
      // problem from a fleet of zombies.
      count('ws.closed', { close: closeOf(detail['close']) });
      gauge('ws.sessions', int(detail, 'sessions'));
      return;
    case 'sync.socket.hello_timeout':
      count('ws.closed', { close: 'hello_timeout' });
      return;
    case 'sync.socket.read_timeout':
      count('ws.closed', { close: 'read_timeout' });
      return;
    case 'sync.socket.too_old':
      count('ws.closed', { close: 'too_old' });
      return;
    case 'sync.socket.unauthenticated':
      count('ws.closed', { close: 'unauthenticated' });
      return;

    // ── frames we did not act on ────────────────────────────────────────────
    case 'sync.frame.unknown':
      // Invariant 43 WORKING, not failing: a newer peer named something this
      // deployment predates. Counted so a release can be watched, never logged
      // as an error.
      count('sync.frame.dropped', { frame: 'unknown' });
      return;
    case 'sync.frame.malformed':
      count('sync.frame.dropped', { frame: 'malformed' });
      return;
    case 'sync.catchup.denied':
    case 'sync.backfill.denied':
      count('sync.frame.dropped', { frame: 'denied' });
      return;

    // ── catch-up ────────────────────────────────────────────────────────────
    case 'sync.gap.sent':
      count('sync.catchup', { answer: 'gap' });
      return;
    case 'sync.catchup.sent':
      count('sync.catchup', { answer: 'replay' });
      // Zero is a real answer here, not a missing one: a level client asks and
      // is told there is nothing, and that is most of this histogram.
      histogram('sync.catchup.events', int(detail, 'events'));
      return;

    // ── the directory ───────────────────────────────────────────────────────
    case 'sync.directory.page':
      // TRACED, NOT COUNTED, and deliberately: pages per directory is
      // ceil(actors / DIRECTORY_PAGE), a number we already hold. The span it
      // hangs on says how long the page took, which is the part we do not.
      return;

    // ── the error boundary ──────────────────────────────────────────────────
    case 'sync.failed':
      // Both signals, and they answer different questions. The counter says
      // WHERE the engine fell over, across everybody, and survives past the
      // 14-day window. The event says which stream and revision, for the one
      // person who is stuck. The error message is on neither — it rides the
      // failed span, which is the only place free text is ever allowed (§6).
      count('sync.failed', { stage: stageOf(detail['stage']) });
      emit('sync.failed', {
        stage: str(detail, 'stage'), frame: str(detail, 'frame'),
        id: str(detail, 'id'), rev: int(detail, 'rev'),
      });
      return;

    default:
      // Unreached in a build that passes observe.test.ts. Left as a silent
      // return rather than a throw, for the same reason the wrapper catches.
      return;
  }
}

const CLOSES = new Set([
  'client_stop', 'server_closing', 'handshake_timeout', 'hello_timeout',
  'read_timeout', 'zombie', 'too_old', 'unauthenticated', 'slow_consumer',
  'error',
] as const);

type Close = 'client_stop' | 'server_closing' | 'handshake_timeout'
  | 'hello_timeout' | 'read_timeout' | 'zombie' | 'too_old'
  | 'unauthenticated' | 'slow_consumer' | 'error';

/**
 * Narrow a close cause, falling back to `error`.
 *
 * The label is a closed set and this is where an open string meets it. An
 * unrecognised value becoming `error` rather than itself is what stops one
 * careless call site turning a ten-series metric into an unbounded one.
 */
const closeOf = (value: unknown): Close =>
  typeof value === 'string' && (CLOSES as Set<string>).has(value)
    ? value as Close : 'error';

// ── direct recorders, for the paths that never had a note seam ──────────────
//
// The engine's own modules — fanout, the ops, the feed, retention — are called
// from more than the socket and have no `note` to route through. They record
// straight, which is fine: what the seam buys is one line at a branch point,
// and these are not branch points.

/** One event committed to the log. */
export const recordAppend = (streamKind: string): void => {
  count('sync.event.appended', { stream: streamOf(streamKind) });
};

/** One fanout, after the transaction that produced it committed. */
export function recordFanout(
  streamKind: string, audience: number, dropped: number, durationMs: number,
): void {
  histogram('sync.fanout.audience', audience, { stream: streamOf(streamKind) });
  histogram('sync.fanout.duration', durationMs);
  // Only when it happened. A counter at zero emits nothing, and for this one
  // absence IS health — the alert is `> 0` rather than a threshold (§9).
  if (dropped > 0) count('sync.fanout.dropped', dropped);
}

/** One write, accepted or refused. */
export function recordOp(
  op: 'send' | 'delete', ok: boolean, durationMs: number,
): void {
  count('sync.op', { op, result: ok ? 'ok' : 'error' });
  histogram('sync.op.duration', durationMs, { op });
}

/** One catch-up answered. */
export const recordCatchupDuration = (answer: 'replay' | 'gap', ms: number): void => {
  histogram('sync.catchup.duration', ms, { answer });
};

/** One welcome frame built. Both numbers feed the §9.9 ceiling. */
export function recordWelcome(bytes: number, chats: number): void {
  histogram('sync.welcome.bytes', bytes);
  histogram('sync.chats_per_actor', chats);
}

/** One retention pass. */
export const recordSweep = (deleted: number): void => {
  if (deleted > 0) count('sync.retention.swept', deleted);
};

/** A slow consumer disconnected mid-fanout. */
export const recordSlowConsumer = (): void => {
  count('ws.closed', { close: 'slow_consumer' });
};

const streamOf = (kind: string): 'chat' | 'space' | 'workspace' =>
  kind === 'space' ? 'space' : kind === 'workspace' ? 'workspace' : 'chat';

const STAGES = new Set(
  ['frame', 'apply', 'catchup', 'directory', 'drain', 'welcome'] as const);

type Stage = 'frame' | 'apply' | 'catchup' | 'directory' | 'drain' | 'welcome';

/** Narrow a stage, falling back to `frame`. Same rule as every other label. */
const stageOf = (value: unknown): Stage =>
  typeof value === 'string' && (STAGES as Set<string>).has(value)
    ? value as Stage : 'frame';
