// The send path as ONE trace — step 13 of the sync build plan.
//
// The criterion this file exists for, from the plan's step 13: *a "user pressed
// send" span on the client links to the server span that assigned the `ord`*.
// Everything else in the instrumentation pass is a number; this is the part
// that answers "what happened to THIS message", which is the question you
// actually have at two in the morning.
//
// It runs the real `createLink` over a fake socket, which is also the first
// test `link.ts` has had. The assembly was never assigned a step — it was
// nobody's until the directory forced it — so it arrived without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { frame, PROTOCOL, type Welcome } from '@relayed/protocol';
import {
  startSpan, setSink, parseTraceparent, type FinishedSpan, type Sink,
} from '@relayed/telemetry';
import { installNetworkGate } from './network.ts';
import { migrate } from './migrate.ts';
import { workspaceMigrations } from './migrations/workspace.ts';
import { createLink } from './link.ts';
import { enqueue, ready, depth, requeueInflight } from './outbox.ts';
import { directoryOwed, backfillFloor, repairOwed } from './catchup.ts';
import { frontierOf } from './apply.ts';
import type { SocketLike } from './transport/connection.ts';

const CHAT = 'cht_eng';

function replica(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db, workspaceMigrations);
  return db;
}

/** A socket a test can open, write to and read from. */
class FakeSocket implements SocketLike {
  sent: string[] = [];
  readyState = 0;
  #handlers = new Map<string, ((...args: never[]) => void)[]>();

  on(event: string, handler: (...args: never[]) => void): void {
    const list = this.#handlers.get(event) ?? [];
    list.push(handler);
    this.#handlers.set(event, list);
  }
  #emit(event: string, ...args: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      (handler as (...a: unknown[]) => void)(...args);
    }
  }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.#emit('close', 1000); }

  accept(): void { this.readyState = 1; this.#emit('open'); }
  deliver(t: string, body: Record<string, unknown> = {}): void {
    this.#emit('message', frame(t, body));
  }
  /** The frames written, parsed — envelope keys included. */
  get frames(): { t: string; traceparent?: string; op_id?: string }[] {
    return this.sent.map(s => JSON.parse(s) as { t: string });
  }
  frameOf(t: string): { t: string; traceparent?: string; op_id?: string } | undefined {
    return this.frames.find(f => f.t === t);
  }
}

const WELCOME = {
  protocol: PROTOCOL, now: Date.now(),
  actor: { id: 'act_1', handle: 'harsh', display_name: 'Harsh Sharma' },
} as unknown as Welcome;

interface Harness {
  db: DatabaseSync;
  socket: FakeSocket;
  link: ReturnType<typeof createLink>;
  spans: FinishedSpan[];
  stop(): void;
}

/** A link over a fake socket, already welcomed, collecting every span. */
async function harness(): Promise<Harness> {
  const db = replica();
  const socket = new FakeSocket();
  // Through `setSink`, which is the path production uses — a test that reached
  // past it would be asserting on wiring nothing else goes through.
  const spans = collect();

  const link = createLink({
    url: 'ws://127.0.0.1:1/sync',
    gate: installNetworkGate({ fetch: globalThis.fetch }),
    db: () => db,
    workspaceId: () => 'wsp_1',
    token: async () => 'tok',
    invalidate: () => {},
    onWelcome: () => {},
    open: () => socket,
  });

  link.start();
  socket.accept();
  // `hello` is sent from an async token read, so the frame lands a turn later.
  await new Promise(resolve => setImmediate(resolve));
  socket.deliver('welcome', WELCOME as unknown as Record<string, unknown>);

  return {
    db, socket, link, spans,
    stop: () => { link.stop(); db.close(); },
  };
}

/** Capture every span this process finishes, through the public sink. */
function collect(): FinishedSpan[] {
  const spans: FinishedSpan[] = [];
  const sink: Sink = {
    event: () => {}, count: () => {}, gauge: () => {}, histogram: () => {},
    recordSpan: (span) => spans.push(span),
  };
  setSink(sink);
  return spans;
}

const named = (spans: FinishedSpan[], name: string): FinishedSpan | undefined =>
  spans.find(s => s.name === name);

/** Queue a send the way a compose surface will: inside a span of its own. */
async function compose(db: DatabaseSync, opId: string, messageId: string): Promise<void> {
  await startSpan('ui.compose', () => {
    enqueue(db, {
      opId, kind: 'send', chatId: CHAT, targetId: messageId,
      payload: { body: 'hello' },
    });
  }, { attributes: { chat_id: CHAT } });
}

// ─── the criterion ──────────────────────────────────────────────────────────

test('the op frame carries the trace of the span that COMPOSED it', async () => {
  // The whole point of the column on the outbox row. A WebSocket carries no
  // headers, so unless the frame says so explicitly the server starts a fresh
  // trace and the compose half of the path is simply gone.
  const h = await harness();
  await compose(h.db, 'op_1', 'msg_1');
  h.link.drain();

  const op = h.socket.frameOf('op');
  assert.ok(op, 'the op went out');
  const carried = parseTraceparent(op.traceparent);
  assert.ok(carried, `the frame carries a traceparent: ${JSON.stringify(op)}`);

  const compose_ = named(h.spans, 'ui.compose');
  assert.ok(compose_, 'the compose span was recorded');
  assert.equal(carried.traceId, compose_.traceId,
    'the frame is in the trace that began when somebody pressed return');
  h.stop();
});

test('the queued row REMEMBERS the trace, so a restart does not lose it', () => {
  collect();
  // An op composed offline on Friday and acked on Monday is one send. An
  // in-memory span cannot bridge that, which is why the context is on the row.
  const db = replica();
  const opId = 'op_restart';
  void startSpan('ui.compose', () => {
    enqueue(db, {
      opId, kind: 'send', chatId: CHAT, targetId: 'msg_r',
      payload: { body: 'hi' },
    });
  });

  const queued = ready(db)[0];
  assert.ok(queued?.traceparent, 'the row carries the context');
  assert.ok(parseTraceparent(queued.traceparent), 'and it is a valid one');
  db.close();
});

test('an op enqueued outside any span still sends — with no traceparent', () => {
  // A missing link is not an error (invariant 43 applied to telemetry). An op
  // that could not be traced must still be a message that gets delivered.
  const db = replica();
  enqueue(db, {
    opId: 'op_bare', kind: 'send', chatId: CHAT, targetId: 'msg_b',
    payload: { body: 'hi' },
  });
  assert.equal(ready(db)[0]?.traceparent, null);
  db.close();
});

test('the ack CLOSES the send span, in the trace it started in', async () => {
  const h = await harness();
  await compose(h.db, 'op_2', 'msg_2');
  h.link.drain();
  h.socket.deliver('ack', {
    op_id: 'op_2', id: 'msg_2', c: CHAT, ord: 7, rev: 7,
    created_at: '2026-09-11T10:00:00.000Z',
  });

  const send = named(h.spans, 'outbox.send');
  const composed = named(h.spans, 'ui.compose');
  assert.ok(send, 'the send span ended');
  assert.equal(send.traceId, composed?.traceId, 'one message, one trace');
  assert.equal(send.parentSpanId, composed?.spanId, 'and the tree is real');
  assert.equal(send.status, 'ok');
  assert.deepEqual(send.events.map(e => e.name), ['socket.write', 'ack'],
    'with the moments in order');
  assert.equal(send.attributes['ord'], 7);
  h.stop();
});

test('a RETRYABLE nack does not end the span — the send is still happening',
  async () => {
    // Ending here would cut the trace in half at exactly the point it got
    // interesting: the retry is the same send, and "this took four attempts" is
    // the thing the span exists to show.
    const h = await harness();
    await compose(h.db, 'op_3', 'msg_3');
    h.link.drain();
    h.socket.deliver('nack', {
      op_id: 'op_3', code: 'unavailable', retryable: true, message: 'later',
    });

    assert.equal(named(h.spans, 'outbox.send'), undefined, 'still open');
    assert.equal(depth(h.db).queued, 1, 'and still queued');
    h.stop();
  });

test('a PERMANENT nack ends the span as an error, carrying the code', async () => {
  const h = await harness();
  await compose(h.db, 'op_4', 'msg_4');
  h.link.drain();
  h.socket.deliver('nack', {
    op_id: 'op_4', code: 'forbidden', retryable: false, message: 'no',
  });

  const send = named(h.spans, 'outbox.send');
  assert.equal(send?.status, 'error');
  assert.equal(send?.error, 'forbidden');
  assert.equal(send?.attributes['nack_code'], 'forbidden');
  h.stop();
});

test('a span still open when the link stops is REPORTED, not abandoned', async () => {
  // An unfinished span is never reported at all, so a leak here does not look
  // like a leak — it looks like a trace missing its last step, which is much
  // harder to notice (invariant 54).
  const h = await harness();
  await compose(h.db, 'op_5', 'msg_5');
  h.link.drain();
  assert.equal(named(h.spans, 'outbox.send'), undefined, 'open while in flight');

  h.link.stop();
  const send = named(h.spans, 'outbox.send');
  assert.equal(send?.status, 'error');
  assert.equal(send?.error, 'link stopped');
  h.db.close();
});

// ─── the reconnect ──────────────────────────────────────────────────────────

test('a connect attempt is one span, and hello carries it', async () => {
  const h = await harness();
  const connect = named(h.spans, 'sync.connect');
  assert.ok(connect, 'the attempt was traced');
  assert.equal(connect.parentSpanId, undefined, 'a root: a reconnect belongs to nothing');
  assert.deepEqual(connect.events.map(e => e.name), ['hello', 'welcome']);

  const hello = h.socket.frameOf('hello');
  assert.equal(parseTraceparent(hello?.traceparent)?.traceId, connect.traceId,
    'so the server’s hello handling joins the client’s reconnect');
  h.stop();
});

test('the directory hydration hangs UNDER the connect that caused it', async () => {
  // Not a root of its own. Everything welcome sets off — the scheduler's sweep,
  // the directory pager — is part of that reconnect, and filing it separately
  // would make a slow reconnect look like several unrelated slow things.
  const h = await harness();
  const connect = named(h.spans, 'sync.connect');
  assert.ok(h.socket.frameOf('directory'), 'the pager asked for a page');
  // Still OPEN until the page lands. That is the point of it — the span covers
  // the wait, which is the part worth measuring.
  assert.equal(named(h.spans, 'sync.directory.hydrate'), undefined);

  h.socket.deliver('directory_ok', {
    rows: [{ id: 'act_2', type: 'human', handle: 'sam', display_name: 'Sam',
             avatar_url: null, owner_actor_id: null, state: 'active',
             updated_at: 1 }],
    next_after_id: null, complete: true, head_rev: 12,
  });
  await new Promise(resolve => setImmediate(resolve));

  const directory = named(h.spans, 'sync.directory.hydrate');
  assert.ok(directory, 'the pager finished');
  assert.equal(directory.traceId, connect?.traceId, 'under the reconnect');
  assert.equal(directory.attributes['actors'], 1);
  h.stop();
});

test('stopping mid-hydration does NOT adopt the directory cursor', async () => {
  // The bug this caught. `stop()` settled the waiting page with a synthetic
  // `{ complete: true }`, and a complete page is precisely how the pager knows
  // it holds the whole directory — so stopping halfway marked the snapshot
  // done at revision 0, and every actor on the pages never fetched would have
  // rendered as a monogram until they happened to change.
  const h = await harness();
  assert.ok(h.socket.frameOf('directory'), 'a page was in flight');
  h.link.stop();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(directoryOwed(h.db, 'wsp_1'), true,
    'the directory is still owed, because it was never fetched');
  h.db.close();
});

// ─── climbing out of a gap ──────────────────────────────────────────────────

const message = (ord: number) => ({
  id: `msg_${ord}`, ord, rev: 9_000 + ord, author_id: 'act_1',
  body: `body ${ord}`, parent_id: null,
});

/** Put the client in the state a gap leaves it in: a tail, and a marked floor. */
function gapped(h: Harness, headOrd: number, tailFrom: number): void {
  h.socket.deliver('gap', {
    stream: { kind: 'chat', id: CHAT }, head_rev: 9_000 + headOrd,
    snapshot: {
      kind: 'messages', head_ord: headOrd,
      recent: Array.from({ length: headOrd - tailFrom + 1 },
                         (_, i) => message(tailFrom + i)),
    },
  });
}

test('A CLIENT HANDED A GAP CAN CLIMB OUT OF IT', async () => {
  // The half of step 9 that was never connected. Both ends existed — the server
  // answers `backfill`, `applyBackfill` applies the reply — and `link.ts`
  // neither sent the request nor routed the response, so a gap was a floor with
  // no way down. That is precisely the failure the gap design exists to avoid:
  // missing-and-MARKED is only better than missing-and-unknown if the mark can
  // be acted on.
  const h = await harness();
  gapped(h, 500, 451);
  assert.deepEqual(backfillFloor(h.db, CHAT), { oldestLocalOrd: 451, headOrd: 500, hasGap: true });

  assert.equal(h.link.backfill(CHAT), true, 'a page was asked for');
  const request = h.socket.frameOf('backfill') as { c?: string; before_ord?: number };
  assert.equal(request?.c, CHAT);
  assert.equal(request.before_ord, 451, 'everything below the tail we hold');

  h.socket.deliver('backfill_ok', {
    c: CHAT, rows: Array.from({ length: 50 }, (_, i) => message(401 + i)),
    complete: false,
  });
  assert.deepEqual(backfillFloor(h.db, CHAT), { oldestLocalOrd: 401, headOrd: 500, hasGap: true },
    'the floor moved down, and the gap is still open');
  h.stop();
});

test('ONE request per chat at a time', async () => {
  // A surface firing a scroll handler on every frame would otherwise send a
  // burst of requests for overlapping ranges, and the replies would arrive out
  // of order into a floor that only moves one way.
  const h = await harness();
  gapped(h, 500, 451);

  assert.equal(h.link.backfill(CHAT), true);
  assert.equal(h.link.backfill(CHAT), false, 'the second is refused');
  assert.equal(h.socket.frames.filter(f => f.t === 'backfill').length, 1);

  h.socket.deliver('backfill_ok', {
    c: CHAT, rows: [message(450)], complete: false,
  });
  assert.equal(h.link.backfill(CHAT), true, 'and allowed again once it settles');
  h.stop();
});

test('reaching the beginning CLOSES the gap, and paging stops', async () => {
  const h = await harness();
  gapped(h, 500, 451);
  h.link.backfill(CHAT);
  h.socket.deliver('backfill_ok', {
    c: CHAT, rows: Array.from({ length: 450 }, (_, i) => message(1 + i)),
    complete: true,
  });

  assert.deepEqual(backfillFloor(h.db, CHAT), { oldestLocalOrd: 1, headOrd: 500, hasGap: false });
  assert.equal(h.link.backfill(CHAT), false, 'nothing left to ask for');
  h.stop();
});

test('a SECOND gap after scrolling to the top is backfilled again, from the new floor', async () => {
  // The finding the sync model made first: with the floor at 1 the client
  // never asked again, and everything a later gap jumped over never arrived
  // (invariant 86).
  const h = await harness();
  gapped(h, 6, 5);
  h.link.backfill(CHAT);
  h.socket.deliver('backfill_ok', { c: CHAT, rows: [1, 2, 3, 4].map(message), complete: true });
  assert.deepEqual(backfillFloor(h.db, CHAT), { oldestLocalOrd: 1, headOrd: 6, hasGap: false });

  gapped(h, 14, 13);
  assert.equal(h.link.backfill(CHAT), true, 'asked again, although the floor was once 1');
  const asked = h.socket.frames.filter(f => f.t === 'backfill').at(-1) as { before_ord?: number } | undefined;
  assert.equal(asked?.before_ord, 13, 'from the NEW tail\'s floor');
  h.socket.deliver('backfill_ok', {
    c: CHAT, rows: Array.from({ length: 12 }, (_, i) => message(1 + i)), complete: true,
  });
  assert.equal(backfillFloor(h.db, CHAT).hasGap, false);
  assert.equal((h.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n, 14,
    'every message, the six the second gap jumped over included');
  h.stop();
});

test('a gap whose tail is EMPTY is backfilled from just above the head, and closes', async () => {
  const h = await harness();
  h.socket.deliver('gap', {
    stream: { kind: 'chat', id: CHAT }, head_rev: 9_014,
    snapshot: { kind: 'messages', head_ord: 14, recent: [] },
  });
  assert.equal(h.link.backfill(CHAT), true);
  const asked = h.socket.frameOf('backfill') as { before_ord?: number } | undefined;
  assert.equal(asked?.before_ord, 15, 'head_ord + 1: there is no floor to ask below');
  h.socket.deliver('backfill_ok', { c: CHAT, rows: [], complete: true });
  assert.equal(backfillFloor(h.db, CHAT).hasGap, false, 'an empty, complete page is what clears it');
  h.stop();
});

// ─── repair, at reconnect ───────────────────────────────────────────────────

const live = (rev: number, ord: number, parent: string | null = null) => ({
  stream: { kind: 'chat', id: CHAT }, rev, type: 'message.created',
  payload: { id: `msg_${ord}`, ord, parent_id: parent, author_id: 'act_1',
             body: `body ${ord}`, created_at: '2026-09-10T16:04:11.238Z' },
});

const repairFrames = (h: Harness) =>
  h.socket.frames.filter(f => f.t === 'repair') as unknown as
    { c: string; since_rev: number; max_ord: number; after: { rev: number; id: string } | null }[];

test('A GAP ASKS FOR REPAIR, and pages until the server says complete', async () => {
  const h = await harness();
  for (let i = 1; i <= 3; i++) h.socket.deliver('ev', live(i, i));
  gapped(h, 500, 451);

  const [first] = repairFrames(h);
  assert.deepEqual(first, { t: 'repair', c: CHAT, since_rev: 3, max_ord: 3, after: null } as unknown,
    'changes since the frontier it jumped from, to messages it held');

  h.socket.deliver('repair_ok', {
    c: CHAT, rows: [{ ...message(2), rev: 100, deleted: true, body: '' }],
    complete: false, after: { rev: 100, id: 'msg_2' },
  });
  assert.equal((h.db.prepare("SELECT deleted FROM messages WHERE id = 'msg_2'").get() as { deleted: number }).deleted, 1,
    'the tombstone applied to the held row');
  assert.deepEqual(repairFrames(h)[1]?.after, { rev: 100, id: 'msg_2' }, 'the next page, from where this one ended');

  h.socket.deliver('repair_ok', { c: CHAT, rows: [], complete: true, after: { rev: 100, id: 'msg_2' } });
  assert.equal(repairFrames(h).length, 2, 'nothing more asked for');
  assert.equal(repairOwed(h.db, CHAT), null, 'and nothing owed');
  h.stop();
});

test('a page older than a live change is rejected, and repair keeps asking until clean', async () => {
  const h = await harness();
  for (let i = 1; i <= 3; i++) h.socket.deliver('ev', live(i, i));
  gapped(h, 500, 451);
  // A live reply to msg_3 lands after the gap, before the first page arrives.
  h.socket.deliver('ev', live(9_501, 501, 'msg_3'));
  const count = () => (h.db.prepare("SELECT reply_count FROM messages WHERE id = 'msg_3'").get() as { reply_count: number }).reply_count;
  assert.equal(count(), 1);

  // The page was computed before that reply: msg_3 with no replies, complete.
  h.socket.deliver('repair_ok', {
    c: CHAT, rows: [{ ...message(3), rev: 200, reply_count: 0 }],
    complete: true, after: { rev: 200, id: 'msg_3' },
  });
  assert.equal(count(), 1, 'the live reply was not wound back');
  assert.equal(repairFrames(h).length, 2, 'complete on the wire is not done: asked again');
  assert.deepEqual(repairFrames(h)[1]?.after, { rev: 200, id: 'msg_3' });

  h.socket.deliver('repair_ok', {
    c: CHAT, rows: [{ ...message(3), rev: 9_501, reply_count: 1 }],
    complete: true, after: { rev: 9_501, id: 'msg_3' },
  });
  assert.equal(repairFrames(h).length, 2);
  assert.equal(repairOwed(h.db, CHAT), null);
  h.stop();
});

test('a thread is paged from the start until the server says the page was the last', async () => {
  const h = await harness();
  h.socket.deliver('ev', live(1, 1));
  assert.equal(h.link.thread(CHAT, 'msg_1'), true);
  assert.equal(h.link.thread(CHAT, 'msg_1'), false, 'one page in flight per thread');
  const asked = () => h.socket.frames.filter(f => f.t === 'thread') as unknown as { root: string; after_ord: number }[];
  assert.deepEqual([asked()[0]?.root, asked()[0]?.after_ord], ['msg_1', 0]);

  h.socket.deliver('thread_ok', {
    c: CHAT, root: 'msg_1', complete: false,
    rows: [{ ...message(2), parent_id: 'msg_1' }, { ...message(5), parent_id: 'msg_1' }],
  });
  assert.equal(asked().length, 2, 'the next page was asked for');
  assert.equal(asked()[1]?.after_ord, 5, 'after the last reply held');
  h.socket.deliver('thread_ok', { c: CHAT, root: 'msg_1', complete: true, rows: [{ ...message(9), parent_id: 'msg_1' }] });
  assert.equal(asked().length, 2);
  assert.equal((h.db.prepare("SELECT COUNT(*) n FROM messages WHERE parent_id = 'msg_1'").get() as { n: number }).n, 3);
  assert.equal(h.link.thread(CHAT, 'msg_1'), true, 'and it can be asked again once done');
  h.stop();
});

test('a chat with NO gap never asks', async () => {
  // Everything below the floor is already here. Asking would be a round trip
  // for rows we hold, on every scroll, for ever.
  const h = await harness();
  assert.equal(h.link.backfill(CHAT), false);
  assert.equal(h.socket.frameOf('backfill'), undefined);
  h.stop();
});

test('a request that could not be written leaves the chat free to retry', async () => {
  // The same rule the outbox drain follows: a socket that closed between the
  // decision and the write must not leave a chat marked in-flight with nothing
  // coming back, because nothing would ever clear it.
  const h = await harness();
  gapped(h, 500, 451);
  h.link.stop();

  assert.equal(h.link.backfill(CHAT), false, 'no socket, no request');
  assert.equal(h.socket.frameOf('backfill'), undefined);
  h.db.close();
});

// ─── an op stranded by a dropped socket ─────────────────────────────────────

test('AN OP IN FLIGHT WHEN THE SOCKET DIES IS SENT AGAIN ON RECONNECT', async () => {
  // Found by a load run: twelve messages across six clients that had been
  // written to a socket and never acked, sitting in `inflight` for ever. `ready`
  // selects `state = 'queued'`, so no drain would ever see them again — the
  // message stayed pending on the sender's screen with no error and no retry.
  // The exact failure the outbox exists to prevent.
  const h = await harness();
  await compose(h.db, 'op_strand', 'msg_strand');
  h.link.drain();
  assert.ok(h.socket.frameOf('op'), 'it went out once');

  const inflight = () => (h.db.prepare(
    "SELECT COUNT(*) n FROM outbox WHERE state = 'inflight'").get() as { n: number }).n;
  assert.equal(inflight(), 1, 'and is awaiting a reply that will never come');

  // The connection dies before the ack, and a new one is welcomed.
  h.link.stop();
  const socket = new FakeSocket();
  const link = createLink({
    url: 'ws://127.0.0.1:1/sync', gate: installNetworkGate({ fetch: globalThis.fetch }),
    db: () => h.db, workspaceId: () => 'wsp_1', token: async () => 'tok',
    invalidate: () => {}, onWelcome: () => {}, open: () => socket,
  });
  link.start();
  socket.accept();
  await new Promise(resolve => setImmediate(resolve));
  socket.deliver('welcome', WELCOME as unknown as Record<string, unknown>);

  const resent = socket.frames.find(f => f.t === 'op') as { op_id?: string } | undefined;
  assert.ok(resent, 'the second connection sent it again');
  assert.equal(resent.op_id, 'op_strand',
    'the SAME op_id, so the server returns the stored ack rather than applying twice');
  link.stop();
  h.db.close();
});

test('a resend does not count as a failed attempt', async () => {
  // A dropped connection is not the op failing. Bumping `attempts` would push
  // a perfectly good message toward a backoff it has not earned.
  const h = await harness();
  await compose(h.db, 'op_attempts', 'msg_attempts');
  h.link.drain();
  h.link.stop();

  const before = (h.db.prepare(
    'SELECT attempts FROM outbox WHERE op_id = ?').get('op_attempts') as { attempts: number });
  assert.equal(requeueInflight(h.db), 1);
  const after = (h.db.prepare(
    'SELECT attempts, state FROM outbox WHERE op_id = ?').get('op_attempts') as
      { attempts: number; state: string });

  assert.equal(after.state, 'queued');
  assert.equal(after.attempts, before.attempts, 'unchanged');
  h.db.close();
});

// ─── the error boundary ─────────────────────────────────────────────────────

/** A link whose effect throws on a chosen event type. */
async function brittle(failOn: string): Promise<Harness> {
  const db = replica();
  const socket = new FakeSocket();
  const spans = collect();
  const link = createLink({
    url: 'ws://127.0.0.1:1/sync',
    gate: installNetworkGate({ fetch: globalThis.fetch }),
    db: () => db,
    workspaceId: () => 'wsp_1',
    token: async () => 'tok',
    invalidate: () => {},
    onWelcome: () => {},
    open: () => socket,
    effect: (_db, _stream, event) => {
      if (event.type === failOn) throw new Error('the replica said no');
      return [];
    },
  });
  link.start();
  socket.accept();
  await new Promise(resolve => setImmediate(resolve));
  socket.deliver('welcome', WELCOME as unknown as Record<string, unknown>);
  return { db, socket, link, spans, stop: () => { link.stop(); db.close(); } };
}

test('AN APPLY THAT THROWS DOES NOT KILL THE ENGINE', async () => {
  // What this replaces: the throw reached `ws`'s message emitter and became an
  // uncaught exception. A load run hit it twice and the only record either
  // left was a stack trace on stderr — no metric, no event, no span, nothing on
  // any dashboard.
  const h = await brittle('message.created');

  assert.doesNotThrow(() => {
    h.socket.deliver('ev', {
      stream: { kind: 'chat', id: CHAT }, rev: 1,
      type: 'message.created', payload: { id: 'msg_1' },
    });
  });

  // And the connection is still usable: one frame failing is not evidence the
  // peer is broken, and closing would turn a bug into a reconnect storm.
  assert.equal(h.link.state, 'live');
  h.stop();
});

test('the failure is REPORTED — as a failed span carrying only the message', async () => {
  const h = await brittle('message.created');
  h.socket.deliver('ev', {
    stream: { kind: 'chat', id: CHAT }, rev: 1,
    type: 'message.created', payload: { id: 'msg_1' },
  });

  const failed = named(h.spans, 'sync.failed');
  assert.ok(failed, 'a span was recorded');
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'the replica said no');
  assert.equal(failed.attributes['stage'], 'frame');
  assert.equal(failed.attributes['frame'], 'ev');
  h.stop();
});

test('the frontier does NOT move, so the event is offered again', async () => {
  // Swallowing is only safe because the writers own their transactions and roll
  // back. A caught failure leaves the replica consistent and the cursor exactly
  // where it was — so the next catch-up re-delivers, and a permanent failure
  // becomes `sync.cursor.stalled` rather than silent loss.
  const h = await brittle('message.created');
  h.socket.deliver('ev', {
    stream: { kind: 'chat', id: CHAT }, rev: 1,
    type: 'message.created', payload: { id: 'msg_1' },
  });
  assert.equal(frontierOf(h.db, { kind: 'chat', id: CHAT }), 0, 'no ground gained');

  // And nothing is left half-written: the next write on this database works,
  // which it would not if a transaction had been left open.
  assert.doesNotThrow(() => {
    h.db.prepare('INSERT INTO staged_events (stream_kind, stream_id, rev, event_type, payload) '
               + "VALUES ('chat', ?, 99, 't', '{}')").run(CHAT);
  });
  h.stop();
});

test('a good event after a bad one still applies', async () => {
  // The boundary must not poison the connection for everything that follows.
  const h = await brittle('message.deleted');
  h.socket.deliver('ev', {
    stream: { kind: 'chat', id: CHAT }, rev: 1,
    type: 'message.deleted', payload: { id: 'msg_x' },
  });
  h.socket.deliver('ev', {
    stream: { kind: 'chat', id: CHAT }, rev: 1,
    type: 'message.created', payload: { id: 'msg_ok' },
  });

  assert.equal(frontierOf(h.db, { kind: 'chat', id: CHAT }), 1, 'the good one landed');
  h.stop();
});

// ─── a workspace switch must not leak across replicas ───────────────────────

test('AN EVENT FOR THE OLD WORKSPACE IS NOT WRITTEN INTO THE NEW REPLICA', async () => {
  // What a switch that forgot to close the socket does, and it is worse than
  // the empty directory that exposed it. The link resolves its database through
  // `storage.workspace`, so a connection still authenticated for the previous
  // workspace goes on delivering THAT workspace's events into the replica of
  // the one you just opened — rows from a tenant you are no longer looking at,
  // with the frontier advancing as though they belonged.
  //
  // Modelled the way the engine does it: the same link, a `db()` that starts
  // returning a different database, and `stop()` in between.
  const before = replica();
  const after = replica();
  let current = before;

  const socket = new FakeSocket();
  collect();
  const link = createLink({
    url: 'ws://127.0.0.1:1/sync',
    gate: installNetworkGate({ fetch: globalThis.fetch }),
    db: () => current,
    workspaceId: () => 'wsp_before',
    token: async () => 'tok',
    invalidate: () => {},
    onWelcome: () => {},
    open: () => socket,
  });
  link.start();
  socket.accept();
  await new Promise(resolve => setImmediate(resolve));
  socket.deliver('welcome', WELCOME as unknown as Record<string, unknown>);

  // The switch: socket down FIRST, then the replica moves underneath.
  link.stop();
  current = after;

  // A frame from the old connection, arriving late. It must reach nothing.
  socket.deliver('ev', {
    stream: { kind: 'chat', id: CHAT }, rev: 1,
    type: 'message.created',
    payload: {
      id: 'msg_leak', ord: 1, parent_id: null, author_id: 'act_1',
      body: 'belongs to the previous workspace',
      created_at: '2026-09-11T10:00:00.000Z',
    },
  });

  const leaked = (after.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n;
  assert.equal(leaked, 0, 'the new replica is untouched');
  assert.equal(frontierOf(after, { kind: 'chat', id: CHAT }), 0,
    'and its frontier did not move for somebody else’s revision');

  before.close();
  after.close();
});

// ─── an agent's definition, online only ─────────────────────────────────────

test('definition(): two readers of one agent send ONE frame and share its answer', async () => {
  const h = await harness();
  const first = h.link.definition('act_triage');
  const second = h.link.definition('act_triage');
  assert.equal(h.socket.frames.filter(f => f.t === 'agent_definition').length, 1);

  const answer = { agent_id: 'act_triage', found: false };
  h.socket.deliver('agent_definition_ok', answer);
  assert.deepEqual(await first, answer);
  assert.deepEqual(await second, answer);
  h.stop();
});

test('definition(): stopping the link settles a waiting reader with null — unreachable, not not-found', async () => {
  const h = await harness();
  const waiting = h.link.definition('act_triage');
  h.link.stop();
  assert.equal(await waiting, null);
  h.db.close();
});
