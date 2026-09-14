// The engine's end of the socket: routing frames into the replica.
//
// This module is where steps 5 to 10 of the sync plan actually meet. Everything
// before it was a piece with a test — a connection, an apply loop, a scheduler,
// a directory pager — and none of them had a caller. This is the caller.
//
// IT WAS NOT IN THE PLAN, which is worth recording rather than smoothing over.
// The plan assigned every piece and never assigned the assembly, so it was
// nobody's step until the directory forced it: `fetchActors` may only be
// deleted once its replacement is RUNNING, and the replacement runs here.
//
// Deliberately thin. Nothing here decides what an event means or how far behind
// a stream is — it decides which function gets called with what, and that is
// all. The moment it starts holding opinions it becomes a second place where
// the frontier rule lives.
import type { DatabaseSync } from 'node:sqlite';
import type { Welcome, DirectoryOk } from '@relayed/protocol';
import { Connection, type LinkState, type SocketLike } from './transport/connection.ts';
import type { Gate } from './network.ts';
import {
  applyEvent, frontierOf, type Envelope, type Stream, type Effect,
} from './apply.ts';
import { replicaEffect } from './effects.ts';
import {
  CatchupScheduler, applyCatchup, applyGap, applyBackfill, backfillFloor,
  applyRepair, applyThread, repairOwed, repairsOwed,
  applyDirectoryPage, directorySnapshotComplete, directoryOwed,
  type MessageRow, type DirectoryRow,
} from './catchup.ts';
import {
  ready, markInflight, requeueInflight, applyAck, applyNack, depth, type Ack,
} from './outbox.ts';
import {
  openSpan, startSpan, annotate, parseTraceparent, type OpenSpan,
} from '@relayed/telemetry';

/** Where the engine can throw. Matches the `stage` label in the catalogue. */
type Stage = 'frame' | 'apply' | 'catchup' | 'directory' | 'drain' | 'welcome';
import { observe } from './observe.ts';

export interface LinkDeps {
  url: string;
  gate: Gate;
  /** The replica for the workspace currently open, or null before one is. */
  db(): DatabaseSync | null;
  workspaceId(): string | null;
  token(): Promise<string | null>;
  /** Wake whatever the renderer has mounted. */
  invalidate(topics: string[]): void;
  /** Everything `welcome` carried, for storage to write. */
  onWelcome(body: Welcome): void;
  onState?(state: LinkState): void;
  onEvent?(name: string, detail?: Record<string, unknown>): void;
  /** Test seams, exactly as on the connection itself. */
  open?(url: string): SocketLike;
  effect?: Effect;
}

export interface Link {
  start(): void;
  stop(): void;
  /** Send whatever the outbox has ready. Called after an enqueue. */
  drain(): void;
  /**
   * Fetch the page of history below what this client holds for a chat.
   *
   * Called by a surface that has scrolled to its floor. Returns false when
   * there is nothing to ask for — no gap, or the beginning is already here —
   * so a caller can page until it is told to stop rather than needing to know
   * the rules itself.
   */
  backfill(chatId: string): boolean;
  /**
   * Fetch a thread's replies, from the start, one page at a time until the
   * server says the page was the last. Called when a surface opens a thread
   * whose replies held disagree with the parent's reply count. From the start
   * rather than from a floor: replies share the chat's ordinal space and can
   * sit anywhere in it, so there is no floor to page from.
   */
  thread(chatId: string, rootId: string): boolean;
  /** Reconnect now — waking from sleep, or a freshly refreshed token. */
  retryNow(): void;
  readonly state: LinkState;
}

export function createLink(deps: LinkDeps): Link {
  /** Record a marker, and let a test see it too. One call site, teed. */
  const note = (name: string, detail: Record<string, unknown> = {}): void => {
    observe(name, detail);
    deps.onEvent?.(name, detail);
  };

  /**
   * THE ERROR BOUNDARY.
   *
   * Every one of these calls reaches the engine from a socket event handler, so
   * a throw does not return to a caller — it reaches `ws`'s emitter and becomes
   * an uncaught exception that kills the process. A load run found two that
   * did exactly that, and the only record either left was a stack trace on
   * somebody's stderr: no metric, no event, no span, nothing on any dashboard.
   *
   * ONE FRAME IS NOT THE CONNECTION. The socket already treats a malformed
   * frame this way — counted, not closed — because the connection behind it may
   * be perfectly healthy and dropping it turns a bug into a reconnect storm.
   * The same reasoning applies a layer up.
   *
   * SWALLOWING IS SAFE HERE and that is not an accident: `applyEvent` and every
   * other writer own their transaction and roll it back, so a caught failure
   * leaves the replica consistent and the frontier exactly where it was. The
   * event will be offered again by the next catch-up. If it fails every time,
   * the frontier never moves — which is `sync.cursor.stalled` a heartbeat
   * later. Loud, bounded, and recoverable, rather than fatal.
   */
  function boundary<T>(
    stage: Stage, about: Record<string, unknown>, run: () => T,
  ): T | undefined {
    try {
      return run();
    } catch (e) {
      failure(stage, about, e);
      return undefined;
    }
  }

  /**
   * Report one caught failure.
   *
   * The MESSAGE goes on a span and nowhere else. Events have no free-text field
   * by construction (OBSERVABILITY.md §6), and a span records only `e.message`
   * — never the thrown value, which can carry anything a caller attached to it.
   */
  function failure(stage: Stage, about: Record<string, unknown>, e: unknown): void {
    const span = openSpan('sync.failed', { attributes: { stage, ...about } });
    span.end('error', e instanceof Error ? e.message : 'error');
    note('sync.failed', { stage, ...about });
  }

  const effect = deps.effect ?? replicaEffect(type =>
    note('sync.event.unknown', { type, stream: 'chat', rev: 0 }));

  /**
   * The sends currently in flight, as spans.
   *
   * Keyed by op id, which is what settles them — an ack or a nack names one.
   * Anything still here at `stop()` is ended there rather than abandoned
   * (invariant 54): an unfinished span is never reported at all, so a leak
   * shows up as a trace that is missing its last step rather than as memory.
   */
  const sending = new Map<string, OpenSpan>();

  let scheduler: CatchupScheduler | null = null;
  /** Chats with a backfill request outstanding. One per chat, like catch-up. */
  const backfilling = new Set<string>();
  /** Chats with a repair page outstanding. One per chat, for the same reason. */
  const repairing = new Set<string>();
  /** Threads with a page outstanding, and the ordinal each has paged through. */
  const threading = new Map<string, number>();
  /**
   * Resolves the directory page currently in flight. One at a time.
   *
   * Takes NULL as well as a page, and the difference is load-bearing: null
   * means "no page is coming", and the pager stops. Handing it a synthetic
   * empty page instead would look like a complete directory.
   */
  let awaitingPage: ((page: DirectoryOk | null) => void) | null = null;

  const connection = new Connection({
    url: deps.url,
    gate: deps.gate,
    token: deps.token,
    ...(deps.open ? { open: deps.open } : {}),
    ...(deps.onState ? { onState: deps.onState } : {}),
    ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),

    // Where the replica says it has got to, read at CONNECT time rather than
    // held: after a long backoff the replica is somewhere else entirely.
    cursors: () => {
      const db = deps.db();
      if (!db) return [];
      return (db.prepare(`SELECT stream_kind, stream_id, synced_through_rev
                            FROM stream_state`).all() as {
        stream_kind: string; stream_id: string; synced_through_rev: number;
      }[]).map(row => ({
        kind: row.stream_kind, id: row.stream_id, rev: row.synced_through_rev,
      }));
    },

    // Guarded like everything else: `onWelcome` runs storage code, and a throw
    // here reaches the socket's message handler exactly as an apply would.
    onWelcome: (body) => { boundary('welcome', {}, () => onWelcomed(body)); },

    onFrame: (t, body) => { route(t, body); },
  });

  function onWelcomed(body: Welcome): void {
    deps.onWelcome(body);
    const db = deps.db();
    if (!db) return;

    // The scheduler is rebuilt per connection, not kept across one. Its whole
    // state is "what have I asked for on THIS socket" — carrying it over a
    // reconnect would leave requests marked in-flight that nothing will ever
    // answer, and the streams behind them would never be asked about again.
    scheduler = new CatchupScheduler(db, (stream, fromRev) => {
      send('catchup', { stream: { kind: stream.kind, id: stream.id }, from_rev: fromRev });
    });
    scheduler.sweep();
    void hydrateDirectory().catch((e: unknown) => {
      failure('directory', { id: deps.workspaceId() ?? 'unknown' }, e);
    });
    // Repairs owed from before this connection — a gap taken on a socket that
    // then dropped, or the app quit mid-repair — are persisted precisely so
    // that they resume here rather than being forgotten with the socket.
    repairing.clear();
    for (const chatId of repairsOwed(db)) repair(chatId);
    // BEFORE the drain. An op written to the socket that died is still marked
    // in flight, and nothing else would ever move it back — `ready` only sees
    // `queued`, so it would sit there for ever while its message rendered as
    // pending. Resending is safe because `op_id` is the client's: the server
    // returns the stored ack rather than applying it twice (invariant 5).
    const requeued = requeueInflight(db);
    if (requeued > 0) note('outbox.requeued', { ops: requeued });
    drain();
  }

  function send(t: string, body: Record<string, unknown>): void {
    // Reaches into the connection's socket rather than exposing one, because a
    // general `send` on the connection would invite anything to write frames —
    // and the set of frames this client sends is small and belongs in one place.
    connection.send(t, body);
  }

  function route(t: string, body: unknown): void {
    boundary('frame', { frame: t }, () => routeInner(t, body));
  }

  function routeInner(t: string, body: unknown): void {
    const db = deps.db();
    if (!db) return;

    if (t === 'ev') {
      const frame = body as { stream: Stream; rev: number; type: string; payload: unknown };
      const started = performance.now();
      const result = applyEvent({ db, effect }, frame.stream,
        { rev: frame.rev, type: frame.type, payload: frame.payload });
      note('sync.applied', { ms: performance.now() - started });
      if (result.topics.length > 0) deps.invalidate(result.topics);
      // ONE coalesced request, decided here rather than per staged event. A
      // client a hundred events behind sees a hundred arrivals and the answer
      // to all of them is the same range.
      if (result.needsCatchup) scheduler?.want(frame.stream);
      return;
    }

    if (t === 'catchup_ok') {
      const frame = body as {
        stream: Stream; events: Envelope[]; complete: boolean;
      };
      const started = performance.now();
      void applyCatchup({ db, effect }, frame.stream, frame.events).then(result => {
        note('sync.applied', { ms: performance.now() - started });
        if (result.topics.length > 0) deps.invalidate(result.topics);
        // Settled AFTER applying, so the scheduler's "am I still behind" reads
        // a frontier that has already moved. Settling first would ask again for
        // a range that was about to be applied.
        scheduler?.settled(frame.stream);
      }).catch((e: unknown) => {
        // A REJECTION, not a throw: `applyCatchup` yields between chunks, so
        // this lands as an unhandled rejection rather than reaching `boundary`
        // above. Settled anyway — leaving the stream marked in flight would
        // mean never asking about it again on this connection.
        failure('catchup', { frame: t, id: frame.stream.id }, e);
        scheduler?.settled(frame.stream);
      });
      return;
    }

    if (t === 'gap') {
      const frame = body as {
        stream: Stream; head_rev: number;
        snapshot: { kind: string; head_ord?: number; recent?: MessageRow[] };
      };
      note('sync.gap.entered', {
        stream: frame.stream.kind, id: frame.stream.id,
        head_rev: frame.head_rev,
        // Read BEFORE the gap is applied, because applying it moves the
        // frontier to the head — so afterwards there is no record of how far
        // behind the client actually was, which is the whole point of the field.
        cursor_rev: frontierOf(db, frame.stream),
      });
      deps.invalidate(applyGap(db, frame.stream, frame.head_rev, frame.snapshot));
      // The directory's gap is not repaired by the gap frame — it says only
      // that a paged snapshot is owed.
      if (frame.stream.kind === 'workspace') void hydrateDirectory();
      // A chat's gap owes a repair: the held messages that changed while this
      // client was too far behind to be told. Asked for now, at reconnect,
      // because a deleted message that stays on screen is not a cosmetic delay.
      if (frame.stream.kind === 'chat') repair(frame.stream.id);
      scheduler?.settled(frame.stream);
      return;
    }

    if (t === 'repair_ok') {
      const frame = body as {
        c: string; rows: MessageRow[]; complete: boolean;
        after: { rev: number; id: string } | null;
      };
      repairing.delete(frame.c);
      const result = applyRepair(db, frame.c, frame.rows, frame.complete, frame.after);
      if (result.topics.length > 0) deps.invalidate(result.topics);
      // Until the server says complete AND nothing on the page was older than
      // what is held: a rejected row is one a live event changed after the
      // page was computed, and paging on serves it again at its new version.
      if (!result.done) repair(frame.c);
      return;
    }

    if (t === 'thread_ok') {
      const frame = body as { c: string; root: string; rows: MessageRow[]; complete: boolean };
      const key = `${frame.c}:${frame.root}`;
      deps.invalidate(applyThread(db, frame.c, frame.rows));
      const last = frame.rows.at(-1);
      if (frame.complete || !last) { threading.delete(key); return; }
      threading.set(key, last.ord);
      send('thread', { c: frame.c, root: frame.root, after_ord: last.ord });
      return;
    }

    if (t === 'pong') {
      // The server is ahead on these. Recording the head is what makes the
      // scheduler notice — `behind` is derived from the two watermarks, so
      // moving one is the whole trigger.
      const frame = body as { behind?: { kind: string; id: string; rev: number }[] };
      for (const ahead of frame.behind ?? []) {
        db.prepare(`
          INSERT INTO stream_state (stream_kind, stream_id, server_head_rev)
          VALUES (?, ?, ?)
          ON CONFLICT(stream_kind, stream_id) DO UPDATE SET
            server_head_rev = MAX(stream_state.server_head_rev, excluded.server_head_rev)
        `).run(ahead.kind, ahead.id, ahead.rev);
      }
      if ((frame.behind ?? []).length > 0) scheduler?.sweep();
      return;
    }

    if (t === 'ack') {
      const frame = body as {
        op_id: string; id: string; c: string; ord: number | null;
        rev: number; created_at: string;
      };
      const ack: Ack = {
        messageId: frame.id, chatId: frame.c, ord: frame.ord,
        rev: frame.rev, createdAt: frame.created_at,
      };
      const settled = applyAck(db, frame.op_id, ack);
      settle(frame.op_id, settled.traceparent, span => {
        span.annotate({ ord: frame.ord ?? undefined, rev: frame.rev });
        span.mark('ack');
      });
      note('outbox.op.acked', { kind: settled.kind ?? 'send' });
      deps.invalidate(settled.topics);
      // The next op for that chat, immediately. One in flight per chat means
      // the queue only moves when the previous one settles — so a drain that
      // did not restart here would stop after the first message.
      drain();
      return;
    }

    if (t === 'nack') {
      const frame = body as {
        op_id: string; code: string; retryable: boolean; message: string;
      };
      const result = applyNack(db, frame.op_id, frame.retryable, frame.code);
      // A RETRYABLE nack does not end the send: the same op goes out again
      // under the same trace, and closing the span here would cut the trace in
      // half at the moment it got interesting.
      if (result.outcome === 'failed') {
        settle(frame.op_id, result.traceparent, span => {
          span.annotate({ nack_code: frame.code, attempts: result.attempts });
          span.end('error', frame.code);
        });
      } else {
        sending.get(frame.op_id)?.mark('nack.retry', { code: frame.code });
      }
      note('outbox.op.failed', {
        code: frame.code, retryable: frame.retryable, outcome: result.outcome,
        kind: result.kind ?? 'send', attempts: result.attempts,
      });
      // A terminal failure changes what a surface renders — the message is
      // marked failed and needs its retry-or-discard affordance. A retryable one
      // changes nothing rendered, so it wakes nothing.
      if (result.topics.length > 0) deps.invalidate(result.topics);
      drain();
      return;
    }

    if (t === 'backfill_ok') {
      const frame = body as { c: string; rows: MessageRow[]; complete: boolean };
      // The new floor is derived from what the page CONTAINED, inside
      // `applyBackfill`. Deriving it here from what was requested would be a
      // second opinion about how far back this client has got, and the two
      // would eventually disagree.
      deps.invalidate(applyBackfill(db, frame.c, frame.rows, frame.complete));
      backfilling.delete(frame.c);
      return;
    }

    if (t === 'directory_ok') {
      const resolve = awaitingPage;
      awaitingPage = null;
      resolve?.(body as DirectoryOk);
      return;
    }
  }

  /**
   * Send whatever is ready, at most one op per chat.
   *
   * Called on `welcome` and after every settled op rather than on a timer. A
   * timer would be a second source of truth about when the queue moves, and the
   * queue already knows — an op settles, the next one for that chat is ready.
   *
   * Nothing is queued in memory: `ready` reads the table every time, so an op
   * enqueued while the socket was down is picked up by the next drain without
   * anything having had to remember it.
   */
  function drain(): void {
    boundary('drain', {}, () => drainInner());
  }

  function drainInner(): void {
    const db = deps.db();
    if (!db) return;
    for (const op of ready(db)) {
      // ONE SPAN PER OP, not per attempt. A retry is the same send, and giving
      // each attempt its own trace would hide exactly what the span exists to
      // show — that this message took four tries and forty seconds.
      let span = sending.get(op.opId);
      if (!span) {
        const parent = parseTraceparent(op.traceparent ?? undefined);
        span = openSpan('outbox.send', {
          ...(parent ? { parent } : { root: true }),
          attributes: { op_id: op.opId, op_kind: op.kind, chat_id: op.chatId },
        });
      }
      span.mark('socket.write', { attempt: op.attempts });
      // INSIDE the span, so the frame carries its traceparent: `connection.send`
      // reads whatever is active, and outside this there is nothing active at
      // all — the drain is triggered by an ack or a welcome, not by a request.
      const sent = span.run(() => connection.send('op', {
        op_id: op.opId, kind: op.kind, c: op.chatId, target: op.targetId,
        ...(op.kind === 'send' ? { m: op.payload } : {}),
      }));
      // Marked in flight only if it actually went. A socket that closed between
      // reading the queue and writing would otherwise leave the op inflight
      // with nothing coming back, and it would never be retried.
      if (sent) { markInflight(db, op.opId); sending.set(op.opId, span); }
      else if (!sending.has(op.opId)) span.end('error', 'no socket');
    }

    // Sampled at every drain rather than on a timer: a drain is the moment the
    // queue can have changed, and a timer would be a second opinion about when.
    const queue = depth(db);
    note('outbox.drained', { depth: queue.queued, oldest: queue.oldest });
  }

  /**
   * Close out a send.
   *
   * The held span when this process queued it, and the row's stored context
   * when it did not — an op composed on Friday and acked on Monday has no span
   * in memory, but the traceparent on its row still links this moment to the
   * trace that began when somebody pressed return.
   */
  function settle(
    opId: string, stored: string | null, decorate: (span: OpenSpan) => void,
  ): void {
    const held = sending.get(opId);
    if (held) {
      sending.delete(opId);
      decorate(held);
      held.end();
      return;
    }
    const parent = parseTraceparent(stored ?? undefined);
    // No span and no stored trace: nothing to attach this to, and inventing a
    // root would be a one-span trace saying an ack arrived for a send nothing
    // recorded. Silence is the honest answer.
    if (!parent) return;
    const span = openSpan('outbox.settle', { parent });
    decorate(span);
    span.end();
  }

  /**
   * Ask for the page of history below this chat's floor.
   *
   * THE MISSING HALF OF STEP 9. Both ends were built — the server answers
   * `backfill`, and `applyBackfill` applies the reply — and nothing joined
   * them, because the assembly was never assigned a step. The symptom is the
   * one the whole gap design exists to avoid: a client handed a gap could see
   * the marked floor and had no way to climb out of it.
   *
   * ONE REQUEST PER CHAT AT A TIME, like the catch-up scheduler and for the
   * same reason. A surface firing a scroll handler on every frame would
   * otherwise send a burst of requests for overlapping ranges.
   */
  function backfill(chatId: string): boolean {
    const db = deps.db();
    if (!db || backfilling.has(chatId)) return false;

    const floor = backfillFloor(db, chatId);
    // No gap means everything below the floor is already here. WHILE THERE IS
    // ONE, always ask — from the floor, including a floor of 1, or from just
    // above the head when the tail held nothing this client may see. It used
    // to refuse both, and both left `has_gap` set for ever: nothing else
    // clears it, and only a page marked complete can (invariant 86). An empty
    // page marked complete is exactly the answer that clears it.
    if (!floor.hasGap) return false;
    const before = floor.oldestLocalOrd ?? floor.headOrd + 1;
    if (before < 1) return false;

    if (!connection.send('backfill', { c: chatId, before_ord: before })) return false;
    backfilling.add(chatId);
    return true;
  }

  /**
   * Ask for the next page of the repair a chat owes, if any and if none is out.
   *
   * ONE PAGE IN FLIGHT PER CHAT, and the next is asked for when the reply
   * lands (`repair_ok`), so a repair of any size is a chain of small frames
   * rather than one large one — and one a quit can interrupt anywhere, since
   * where it got to is in the replica, not here.
   */
  function repair(chatId: string): boolean {
    const db = deps.db();
    if (!db || repairing.has(chatId)) return false;
    const owed = repairOwed(db, chatId);
    if (!owed) return false;
    if (!connection.send('repair', {
      c: chatId, since_rev: owed.sinceRev, max_ord: owed.maxOrd, after: owed.after,
    })) return false;
    repairing.add(chatId);
    return true;
  }

  function thread(chatId: string, rootId: string): boolean {
    const key = `${chatId}:${rootId}`;
    if (!deps.db() || threading.has(key)) return false;
    if (!connection.send('thread', { c: chatId, root: rootId, after_ord: 0 })) return false;
    threading.set(key, 0);
    return true;
  }

  /**
   * Page the directory, and invalidate after EACH page.
   *
   * On a fresh device the first page is the difference between every author
   * being a monogram and most of them having a name, and it lands seconds
   * before the last one. Invalidating once at the end would hold that back for
   * no reason.
   */
  async function hydrateDirectory(): Promise<void> {
    const db = deps.db();
    const workspaceId = deps.workspaceId();
    if (!db || !workspaceId || !directoryOwed(db, workspaceId)) return;
    // ONE span for the whole hydration, with a mark per page — the operation is
    // "fill in the directory", and a span per page would be a dozen traces for
    // one thing that either finished or did not.
    await startSpan('sync.directory.hydrate', () => pageDirectory(db, workspaceId),
                    { attributes: { workspace_id: workspaceId } });
  }

  async function pageDirectory(
    db: DatabaseSync, workspaceId: string,
  ): Promise<void> {
    let after: string | null = null;
    let actors = 0;
    for (;;) {
      const page = await requestPage(after);
      if (!page) return;                       // the socket went away mid-fetch
      deps.invalidate(applyDirectoryPage(db, workspaceId, page.rows as DirectoryRow[]));
      actors += page.rows.length;
      note('sync.directory.page', { rows: page.rows.length });

      if (page.complete || page.next_after_id === null) {
        // Only after the LAST page. Adopting the cursor earlier would leave the
        // client believing it held a directory it had only started fetching,
        // and every actor on later pages missing until they happened to change.
        directorySnapshotComplete(db, workspaceId, page.head_rev);
        annotate({ actors });
        note('sync.directory.complete', { workspace: workspaceId, actors });
        return;
      }
      after = page.next_after_id;
    }
  }

  /** One page, or null if the connection went away while waiting. */
  function requestPage(afterId: string | null): Promise<DirectoryOk | null> {
    return new Promise(resolve => {
      let settled = false;
      awaitingPage = (page) => { if (!settled) { settled = true; resolve(page); } };
      send('directory', { after_id: afterId });
      // A DEADLINE, because every state that waits on the outside world carries
      // one (invariant 64). Without it a reply that never comes leaves this
      // promise — and the pager awaiting it — pending for the life of the
      // process.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        awaitingPage = null;
        note('sync.directory.timeout');
        resolve(null);
      }, 15_000);
      timer.unref?.();
    });
  }

  return {
    start: () => { connection.start(); },
    drain,
    backfill,
    thread,
    stop: () => {
      // The pager may be waiting on a page that will never arrive now. Settling
      // it is the difference between a stopped link and a stopped link holding
      // a promise nobody will resolve (invariant 54).
      const waiting = awaitingPage;
      awaitingPage = null;
      // NULL, not an empty page. This settled with `{ complete: true }`, and a
      // complete page is how the pager knows it has the whole directory — so
      // stopping mid-hydration adopted the cursor for a snapshot that had only
      // started, and every actor on the pages never fetched would have rendered
      // as a monogram until they happened to change. The pager already has a
      // word for "no page is coming"; this is it.
      waiting?.(null);
      // Same rule for spans: one still open when the link stops is never
      // reported at all, so the trace would simply lack its last step rather
      // than showing a send that did not finish.
      for (const span of sending.values()) span.end('error', 'link stopped');
      sending.clear();
      // Cleared rather than left, or a chat with a request outstanding when the
      // link stopped could never ask again on the next connection.
      backfilling.clear();
      repairing.clear();
      threading.clear();
      scheduler = null;
      connection.stop();
    },
    retryNow: () => { connection.retryNow(); },
    get state() { return connection.state; },
  };
}
