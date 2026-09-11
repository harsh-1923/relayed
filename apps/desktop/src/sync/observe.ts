// What the sync engine reports, client side — step 13 of the build plan.
//
// The mirror of `apps/server/src/sync/observe.ts`, and the same trade: the
// engine already had a single `onEvent(name, detail)` seam at every branch
// worth a marker, so this turns that seam into the wiring rather than adding a
// second call beside each one. `observe.test.ts` greps the engine for every
// name it can emit and fails on any this switch does not handle.
//
// WHAT IS DIFFERENT ABOUT THE CLIENT HALF. Everything here is bounded, lossy
// and lower priority than user data (OBSERVABILITY.md §7): the buffer behind
// `emit` drops oldest on overflow while the outbox never drops anything. That
// asymmetry is the reason the two are separate mechanisms, and it is why this
// file may be called from anywhere without thinking about back-pressure.
import { count, emit, histogram } from '@relayed/telemetry';
import { CLOSE } from '@relayed/protocol';

const int = (detail: Record<string, unknown>, key: string): number =>
  typeof detail[key] === 'number' ? detail[key] : 0;
const str = (detail: Record<string, unknown>, key: string): string =>
  typeof detail[key] === 'string' ? detail[key] : 'unknown';

/**
 * Record one engine note.
 *
 * Never throws. This runs inside frame handling and inside the apply loop, and
 * an instrumentation bug that could break either would be a worse failure than
 * anything it was measuring.
 */
export function observe(name: string, detail: Record<string, unknown> = {}): void {
  try { dispatch(name, detail); } catch { /* telemetry never breaks the engine */ }
}

function dispatch(name: string, detail: Record<string, unknown>): void {
  switch (name) {
    // ── the connection ──────────────────────────────────────────────────────
    case 'ws.connected':
      // The EVENT only. A client-side `ws.sessions` gauge was written here and
      // then removed: it is a one-or-zero that no panel reads, and the server
      // already reports the number that matters. A marker nobody reads costs
      // cardinality, ingest and attention — the same argument that declined
      // four metrics in the catalogue.
      emit('ws.connected', { attempt: int(detail, 'attempt') });
      return;
    case 'ws.disconnected':
      emit('ws.disconnected', {
        code: int(detail, 'code'), uptime: int(detail, 'uptime'),
      });
      count('ws.closed', { close: closeOf(int(detail, 'code')) });
      return;
    case 'ws.zombie.detected':
      // A socket that is open and dead. Both signals, because they answer
      // different questions: the event says which device and when, the counter
      // says whether it is happening to everybody at once.
      emit('ws.zombie.detected', { last_pong: int(detail, 'last_pong') });
      count('ws.closed', { close: 'zombie' });
      return;
    case 'ws.handshake.timeout':
      count('ws.closed', { close: 'handshake_timeout' });
      return;
    case 'sync.socket.too_old':
      count('ws.closed', { close: 'too_old' });
      return;

    // ── frames we did not act on ────────────────────────────────────────────
    case 'sync.frame.unknown':
      count('sync.frame.dropped', { frame: 'unknown' });
      return;
    case 'sync.frame.malformed':
      count('sync.frame.dropped', { frame: 'malformed' });
      return;

    // ── the apply loop ──────────────────────────────────────────────────────
    case 'sync.event.unknown':
      // Invariant 32: the cursor advanced without the event being applied. The
      // TYPE is the actionable half — a count on its own says old clients are
      // meeting new ops and not which op to care about.
      emit('sync.event.unknown', {
        stream: str(detail, 'stream'), type: str(detail, 'type'),
        rev: int(detail, 'rev'),
      });
      return;
    case 'sync.applied':
      histogram('sync.apply.duration', int(detail, 'ms'));
      return;
    case 'sync.frontier':
      // Sampled per sweep rather than per event. Invariant 1's two numbers:
      // how far behind, and how much is held out of order waiting for a hole
      // that may never be filled.
      histogram('sync.cursor.lag', int(detail, 'lag'));
      histogram('sync.staged.depth', int(detail, 'staged'));
      return;
    case 'sync.cursor.stalled':
      emit('sync.cursor.stalled', {
        stream: str(detail, 'stream'), id: str(detail, 'id'),
        cursor_rev: int(detail, 'cursor_rev'), head_rev: int(detail, 'head_rev'),
        lag: int(detail, 'lag'),
      });
      return;

    // ── falling behind, and climbing back ───────────────────────────────────
    case 'sync.gap.entered':
      emit('sync.gap.entered', {
        stream: str(detail, 'stream'), id: str(detail, 'id'),
        head_rev: int(detail, 'head_rev'), cursor_rev: int(detail, 'cursor_rev'),
      });
      count('sync.gap', { stream: streamOf(str(detail, 'stream')) });
      return;
    case 'sync.backfill.page':
      emit('sync.backfill.page', {
        chat_id: str(detail, 'chat_id'), rows: int(detail, 'rows'),
        duration: int(detail, 'duration'),
      });
      count('sync.backfill.page');
      return;

    // ── the directory ───────────────────────────────────────────────────────
    case 'sync.directory.page':
      // Not counted, deliberately: pages per directory is ceil(actors / page
      // size). The question worth asking is whether the pager FINISHED, which
      // is `directory.synced` below.
      return;
    case 'sync.directory.complete':
      count('directory.synced', { result: 'ok' });
      emit('directory.synced', {
        workspace: str(detail, 'workspace'), actors: int(detail, 'actors'),
      });
      return;
    case 'sync.directory.timeout':
      // A page that never came back. Counted as a failed directory sync rather
      // than as a dropped frame: the consequence is authors rendering as
      // monograms, which is a directory problem, not a transport one.
      count('directory.synced', { result: 'error' });
      return;

    // ── the write path ──────────────────────────────────────────────────────
    //
    // Counted on the way OUT, never on the way in. An enqueue counter and a
    // settle counter would answer the same question twice while disagreeing
    // whenever anything is in flight; how ops LEAVE is the half that says
    // whether the write path works. `outbox.depth` covers what is still there.
    case 'outbox.coalesced':
      emit('outbox.coalesced', { dropped: int(detail, 'dropped') });
      count('outbox.op', { op: 'send', settled: 'coalesced' });
      return;
    case 'outbox.op.acked':
      count('outbox.op', { op: opOf(detail), settled: 'acked' });
      return;
    case 'outbox.op.failed':
      emit('outbox.op.failed', {
        attempts: int(detail, 'attempts'),
        retryable: detail['retryable'] === true,
      });
      count('outbox.op', {
        op: opOf(detail),
        settled: detail['retryable'] === true ? 'retrying' : 'failed',
      });
      return;
    case 'outbox.discarded':
      count('outbox.op', { op: opOf(detail), settled: 'discarded' });
      return;
    case 'outbox.requeued':
      // Ops that were on a socket when it died, put back. Not a failure — the
      // op_id makes the resend idempotent — but a rising rate is a connection
      // dropping mid-write often enough to be worth knowing about.
      count('outbox.op', { op: 'send', settled: 'retrying' }, int(detail, 'ops'));
      return;
    case 'outbox.drained':
      histogram('outbox.depth', int(detail, 'depth'));
      // Depth alone cannot say this: one op stuck for an hour and sixty from
      // the last minute are the same depth and very different problems.
      histogram('outbox.oldest.age', int(detail, 'oldest'));
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
      return;
  }
}

/**
 * The close code, as a cause.
 *
 * 1000 is a NORMAL close, and here it always means we closed it — the transport
 * drops its own socket that way when it gives up on one. Reading it as an error
 * would make every backoff look like a failure.
 */
function closeOf(code: number): 'client_stop' | 'server_closing' | 'too_old'
  | 'unauthenticated' | 'slow_consumer' | 'hello_timeout' | 'error' {
  if (code === 1000) return 'client_stop';
  if (code === CLOSE.goingAway) return 'server_closing';
  if (code === CLOSE.tooOld) return 'too_old';
  if (code === CLOSE.unauthenticated) return 'unauthenticated';
  if (code === CLOSE.slowConsumer) return 'slow_consumer';
  if (code === CLOSE.helloTimeout) return 'hello_timeout';
  return 'error';
}

const streamOf = (kind: string): 'chat' | 'space' | 'workspace' =>
  kind === 'space' ? 'space' : kind === 'workspace' ? 'workspace' : 'chat';

/** Op kinds this phase can queue. Edits and reactions widen it in Phase 4. */
const opOf = (detail: Record<string, unknown>): 'send' | 'delete' =>
  detail['kind'] === 'delete' ? 'delete' : 'send';

const STAGES = new Set(
  ['frame', 'apply', 'catchup', 'directory', 'drain', 'welcome'] as const);

type Stage = 'frame' | 'apply' | 'catchup' | 'directory' | 'drain' | 'welcome';

/** Narrow a stage, falling back to `frame`. Same rule as every other label. */
const stageOf = (value: unknown): Stage =>
  typeof value === 'string' && (STAGES as Set<string>).has(value)
    ? value as Stage : 'frame';
