// The connection lifecycle, driven through a fake socket.
//
// Fake rather than real, and deliberately: every property here is about what
// happens on a TRANSITION — a close that arrives late, a pong that never comes,
// a token that is refused — and provoking those against a real server means
// either sleeping for seconds or breaking it on purpose. The one thing a fake
// cannot prove, that the frames are mutually intelligible, is asserted end to
// end in the server's own socket test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frame, CLOSE, PROTOCOL } from '@relayed/protocol';
import { installNetworkGate } from '../network.ts';
import {
  Connection, backoffDelay,
  type SocketLike, type LinkState, type ConnectionDeps,
} from './connection.ts';

/** A socket a test can open, deliver to, and close from either side. */
class FakeSocket implements SocketLike {
  sent: string[] = [];
  readyState = 0;
  closedWith: number | null = null;
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
  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = code;
    this.#emit('close', code);
  }

  // ── what a test drives ──
  accept(): void { this.readyState = 1; this.#emit('open'); }
  deliver(t: string, body: Record<string, unknown> = {}): void {
    this.#emit('message', frame(t, body));
  }
  raw(text: string): void { this.#emit('message', text); }
  hangUp(code: number): void {
    this.readyState = 3;
    this.closedWith = code;
    this.#emit('close', code);
  }
  get frames(): { t: string }[] {
    return this.sent.map(s => JSON.parse(s) as { t: string });
  }
}

const WELCOME = {
  protocol: PROTOCOL, now: Date.now(),
  actor: { id: 'act_1', handle: 'harsh', display_name: 'Harsh Sharma' },
};

interface Harness {
  connection: Connection;
  sockets: FakeSocket[];
  states: LinkState[];
  events: string[];
  latest(): FakeSocket;
}

function harness(over: Partial<ConnectionDeps> = {}): Harness {
  const sockets: FakeSocket[] = [];
  const states: LinkState[] = [];
  const events: string[] = [];
  const gate = installNetworkGate({ fetch: globalThis.fetch }, { allowOffline: true });
  gate.uninstall();   // we want the gate object, not a patched global

  const connection = new Connection({
    url: 'ws://127.0.0.1:1/sync',
    gate,
    token: async () => 'tok',
    open: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    onState: s => states.push(s),
    onEvent: name => events.push(name),
    // Fixed draw, so a backoff is deterministic without being zero — zero
    // would reconnect inside the same tick and hide ordering bugs.
    random: () => 0.5,
    heartbeatMs: 20,
    readTimeoutMs: 40,
    helloTimeoutMs: 60,
    ...over,
  });

  return { connection, sockets, states, events, latest: () => sockets[sockets.length - 1]! };
}

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ─── the handshake ──────────────────────────────────────────────────────────

test('connecting sends hello with the token and the protocol version', async () => {
  const h = harness();
  h.connection.start();
  assert.equal(h.connection.state, 'connecting');

  h.latest().accept();
  await tick();

  const hello = JSON.parse(h.latest().sent[0] ?? '{}') as
    { t: string; protocol: number; access_token: string };
  assert.equal(hello.t, 'hello');
  assert.equal(hello.protocol, PROTOCOL);
  assert.equal(hello.access_token, 'tok');
  h.connection.stop();
});

test('welcome makes it live and resets the attempt counter', async () => {
  const h = harness();
  h.connection.start();
  h.latest().accept();
  await tick();
  h.latest().deliver('welcome', WELCOME);

  assert.equal(h.connection.state, 'live');
  assert.equal(h.connection.attempt, 0);
  assert.deepEqual(h.states, ['connecting', 'live']);
  h.connection.stop();
});

test('welcome reaches the caller, so later steps can hang cursors off it', async () => {
  let got: unknown = null;
  const h = harness({ onWelcome: (body: unknown) => { got = body; } });
  h.connection.start();
  h.latest().accept();
  await tick();
  h.latest().deliver('welcome', WELCOME);

  assert.equal((got as { actor: { handle: string } }).actor.handle, 'harsh');
  h.connection.stop();
});

test('no token means unauthorised, and no socket traffic at all', async () => {
  // A signed-out app must not open a socket every few seconds for ever. This is
  // "nothing to connect WITH", which is different from "failed to connect".
  const h = harness({ token: async () => null });
  h.connection.start();
  h.latest().accept();
  await tick();

  assert.equal(h.connection.state, 'unauthorised');
  assert.deepEqual(h.latest().sent, [], 'nothing was sent');
  h.connection.stop();
});

// ─── the gate ───────────────────────────────────────────────────────────────

test('simulated offline refuses the socket, and no socket is constructed', async () => {
  // The reason this module exists. Patching fetch catches fetch and nothing
  // else, so an ungated socket would stay connected while the UI insisted the
  // network was cut — worse than not simulating at all, because it looks right.
  const gate = installNetworkGate({ fetch: globalThis.fetch }, { allowOffline: true });
  gate.uninstall();
  gate.setOffline(true);
  const h = harness({ gate });

  h.connection.start();
  assert.equal(h.sockets.length, 0, 'the gate refused before the constructor ran');
  assert.equal(h.connection.state, 'backoff');
  h.connection.stop();
});

// ─── forward compatibility ──────────────────────────────────────────────────

test('an UNKNOWN frame type is ignored and the connection stays live', async () => {
  // Invariant 43, from the client's side. A server that ships a new frame type
  // must not break a client that predates it — and clients in the field are
  // months old, because updates are opt-in.
  const h = harness();
  h.connection.start();
  h.latest().accept();
  await tick();
  h.latest().deliver('welcome', WELCOME);

  h.latest().deliver('reaction.added', { id: 'rct_1' });
  h.latest().deliver('counters', { c: 'cht_1', chat_unread: 3 });

  assert.equal(h.connection.state, 'live');
  assert.equal(h.events.filter(e => e === 'sync.frame.unknown').length, 2);
  h.connection.stop();
});

test('a MALFORMED frame is ignored and the connection stays live', async () => {
  const h = harness();
  h.connection.start();
  h.latest().accept();
  await tick();
  h.latest().deliver('welcome', WELCOME);

  h.latest().raw('{not json');
  h.latest().raw(JSON.stringify({ no: 'frame type' }));
  h.latest().raw(JSON.stringify({ t: 'welcome', actor: 'not an object' }));

  assert.equal(h.connection.state, 'live');
  assert.equal(h.events.filter(e => e === 'sync.frame.malformed').length, 3);
  h.connection.stop();
});

test('a welcome carrying fields this client predates still makes it live', async () => {
  // The promise every later step depends on: a server that starts sending
  // something new must not require every client to update first.
  //
  // The fixture named `spaces` until the step that declared it, at which point
  // this failed — correctly, because `spaces` had stopped being unknown and its
  // placeholder shape no longer validated. Whatever stands in for "a field from
  // the future" has to be something no version will ever declare.
  const h = harness();
  h.connection.start();
  h.latest().accept();
  await tick();
  h.latest().deliver('welcome', {
    ...WELCOME,
    weather_on_the_server: 'drizzle',
    presence: [{ actor: 'act_2', typing: true }],
  });

  assert.equal(h.connection.state, 'live');
  h.connection.stop();
});

// ─── being told to go away ──────────────────────────────────────────────────

test('`too_old` stops for good — retrying cannot help', async () => {
  const h = harness();
  h.connection.start();
  h.latest().accept();
  await tick();
  h.latest().deliver('too_old', { min_protocol: 99, message: 'Please update.' });

  assert.equal(h.connection.state, 'stopped');
  await tick(80);
  assert.equal(h.sockets.length, 1, 'and it did not try again');
});

test('close 4001 parks in `unauthorised` rather than retrying the same token',
  async () => {
    // Reconnecting with a token the server has already refused is a tight loop
    // against a server that said no. Something with a better token restarts it.
    const h = harness();
    h.connection.start();
    h.latest().accept();
    await tick();
    h.latest().hangUp(CLOSE.unauthenticated);

    assert.equal(h.connection.state, 'unauthorised');
    await tick(80);
    assert.equal(h.sockets.length, 1, 'no reconnect while the token is the problem');
  });

test('retryNow revives an unauthorised connection immediately', async () => {
  const h = harness();
  h.connection.start();
  h.latest().accept();
  await tick();
  h.latest().hangUp(CLOSE.unauthenticated);
  assert.equal(h.connection.state, 'unauthorised');

  h.connection.retryNow();
  assert.equal(h.connection.state, 'connecting');
  assert.equal(h.sockets.length, 2);
  h.connection.stop();
});

test('an ordinary close backs off and reconnects', async () => {
  const h = harness();
  h.connection.start();
  h.latest().accept();
  await tick();
  h.latest().deliver('welcome', WELCOME);
  h.latest().hangUp(1006);

  assert.equal(h.connection.state, 'backoff');
  await tick(700);   // 0.5 of a 1s ceiling
  assert.ok(h.sockets.length >= 2, 'it came back');
  h.connection.stop();
});

// ─── the heartbeat ──────────────────────────────────────────────────────────

test('a live connection pings, and a pong keeps it alive', async () => {
  const h = harness();
  h.connection.start();
  h.latest().accept();
  await tick();
  const socket = h.latest();
  socket.deliver('welcome', WELCOME);

  for (let i = 0; i < 3; i++) {
    await tick(25);
    socket.deliver('pong');
  }
  assert.ok(socket.frames.filter(f => f.t === 'ping').length >= 3);
  assert.equal(h.connection.state, 'live', 'answered pings keep it up');
  h.connection.stop();
});

test('a ping with no pong is a zombie, and it reconnects', async () => {
  // A socket that is open but dead is indistinguishable from a quiet one
  // without this deadline, and the app would sit for ever believing it was
  // synced. This is the sleep/wake case that TCP will not tell us about.
  const h = harness();
  h.connection.start();
  h.latest().accept();
  await tick();
  h.latest().deliver('welcome', WELCOME);

  await tick(90);   // heartbeat 20 + read deadline 40, with slack
  assert.ok(h.events.includes('ws.zombie.detected'));
  assert.notEqual(h.connection.state, 'live');
  h.connection.stop();
});

test('ANY frame resets the deadline, not just a pong', async () => {
  // A busy connection should not be killed for failing to answer a heartbeat it
  // never needed to send.
  //
  // Generous read deadline on purpose. An earlier version ran this at 40ms
  // against a frame every 25ms, and the ten milliseconds of slack were inside
  // real timer drift — so it failed for a reason that had nothing to do with
  // the property. A test whose margin is the thing under test measures the
  // scheduler.
  const h = harness({ readTimeoutMs: 200 });
  h.connection.start();
  h.latest().accept();
  await tick();
  const socket = h.latest();
  socket.deliver('welcome', WELCOME);

  for (let i = 0; i < 4; i++) {
    await tick(25);
    socket.deliver('some.event', { n: i });
  }
  assert.equal(h.connection.state, 'live');
  assert.equal(h.events.includes('ws.zombie.detected'), false);
  h.connection.stop();
});

// ─── the things that leak ───────────────────────────────────────────────────

test('stop() closes the socket and nothing fires afterwards', async () => {
  // A teardown must settle everything it abandons (invariant 54). Both Phase 1
  // bugs in this area were cleanup that did not run on an exit path.
  const h = harness();
  h.connection.start();
  h.latest().accept();
  await tick();
  h.latest().deliver('welcome', WELCOME);

  const socket = h.latest();
  const sentBefore = socket.sent.length;
  h.connection.stop();

  assert.equal(h.connection.state, 'stopped');
  assert.equal(socket.closedWith, 1000, 'the socket was actually closed');
  await tick(120);
  assert.equal(socket.sent.length, sentBefore, 'no heartbeat kept firing');
  assert.equal(h.sockets.length, 1, 'and no reconnect was scheduled');
});

test('a stale socket closing does not disturb its successor', async () => {
  // The generation guard, and the bug it prevents: a close arriving from a
  // socket already abandoned would reset the successor's backoff, which is
  // exactly how a reconnect loop becomes a hot loop.
  // Long handshake deadline: this test waits out a backoff before accepting the
  // replacement socket, and a 60ms deadline would expire during that wait —
  // failing on the handshake timeout rather than on what is being asserted.
  const h = harness({ helloTimeoutMs: 5_000 });
  h.connection.start();
  const first = h.latest();
  first.accept();
  await tick();
  first.hangUp(1006);
  await tick(700);

  const second = h.latest();
  assert.notEqual(second, first, 'a new socket exists');
  second.accept();
  await tick();
  second.deliver('welcome', WELCOME);
  assert.equal(h.connection.state, 'live');

  // The corpse speaks. Nothing should happen.
  first.hangUp(1006);
  assert.equal(h.connection.state, 'live', 'the successor was untouched');
  h.connection.stop();
});

test('a handshake that hangs is abandoned on its deadline', async () => {
  // Every state that waits on the outside world carries a deadline (invariant
  // 64). A socket that opens and is never welcomed is the sign-in hang wearing
  // a different hat.
  const h = harness();
  h.connection.start();
  h.latest().accept();
  await tick();
  // ...and the server says nothing at all.

  await tick(100);
  assert.ok(h.events.includes('ws.handshake.timeout'));
  assert.notEqual(h.connection.state, 'connecting');
  h.connection.stop();
});

// ─── backoff ────────────────────────────────────────────────────────────────

test('backoff is FULL jitter — a uniform draw, not a fixed delay', async () => {
  // Not politeness. Ten thousand clients reconnecting together is a `welcome`
  // burst and a catch-up burst landing in one instant (invariant 31). "Cap plus
  // a wobble" still has everyone arriving in the same narrow band, so this
  // asserts the draw spans the whole window rather than clustering.
  const draws: number[] = [];
  let next = 0;
  const h = harness({ random: () => { const r = next; draws.push(r); return r; } });

  for (const r of [0, 0.25, 0.5, 0.99]) {
    next = r;
    h.connection.start();
    h.latest().accept();
    await tick();
    h.latest().hangUp(1006);
    h.connection.stop();
  }

  assert.deepEqual(draws, [0, 0.25, 0.5, 0.99],
    'the delay is the draw times the ceiling, so the whole window is reachable');
});

test('the backoff ceiling doubles, then stops at the cap', () => {
  // Doubling without a cap reaches hours, and a client that sleeps for hours
  // after a blip is indistinguishable from one that is broken.
  //
  // Asserted on the curve rather than by driving eight real reconnects and
  // timing them. That version existed first, took most of a second, and failed
  // for a reason unrelated to backoff — `start()` is idempotent, so calling it
  // again while already backing off did nothing and the attempt never advanced.
  const ceiling = (attempt: number) => backoffDelay(attempt, () => 1);
  assert.deepEqual([0, 1, 2, 3, 4].map(ceiling), [1_000, 2_000, 4_000, 8_000, 16_000]);
  assert.equal(ceiling(5), 30_000, 'capped');
  assert.equal(ceiling(50), 30_000, 'and stays capped rather than overflowing');
});

test('backoff draws from the WHOLE window, floor included', () => {
  // Full jitter, which is the property that matters after a server restart:
  // every client has failed the same number of times, so a curve without the
  // draw returns all of them in one instant.
  assert.equal(backoffDelay(3, () => 0), 0, 'a client may return immediately');
  assert.equal(backoffDelay(3, () => 1), 8_000, 'or at the very end of the window');
  assert.equal(backoffDelay(3, () => 0.5), 4_000);
});

test('consecutive failures escalate, and a welcome resets them', async () => {
  // The counter the curve is read with. Reset on success is what stops a client
  // that reconnects fine after one blip from waiting half a minute on the next.
  const h = harness({ random: () => 0 });
  h.connection.start();
  h.latest().accept();
  await tick();
  h.latest().hangUp(1006);
  assert.equal(h.connection.attempt, 1);

  await tick(20);
  h.latest().accept();
  await tick();
  h.latest().hangUp(1006);
  assert.equal(h.connection.attempt, 2, 'a second failure in a row');

  await tick(20);
  h.latest().accept();
  await tick();
  h.latest().deliver('welcome', WELCOME);
  assert.equal(h.connection.attempt, 0, 'success clears the debt');
  h.connection.stop();
});
