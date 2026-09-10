// The client against a REAL socket, over a real TCP connection.
//
// Everything else about the lifecycle is asserted against a fake, because
// provoking a transition — a late close, a pong that never arrives — through a
// real server means either sleeping for seconds or breaking it on purpose. What
// a fake cannot check is the seam it replaces: that `defaultOpen` returns
// something matching `SocketLike`, that `ws` names its events the way this code
// listens for them, and that a message arrives as a Buffer which survives being
// turned back into a string.
//
// Each of those is a one-line assumption that would fail identically — a client
// that connects, says nothing, and times out — and none of them is visible in a
// test that supplies its own socket.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket } from 'ws';
import { frame, readFrame, INBOUND, PROTOCOL } from '@relayed/protocol';
import { installNetworkGate } from '../network.ts';
import { Connection } from './connection.ts';

/** The smallest server that speaks the protocol. Not the real one — that has */
/** its own tests; this exists to be genuinely on the other end of a socket.  */
let server: WebSocketServer;
let url: string;
const seen: string[] = [];

before(async () => {
  server = new WebSocketServer({ port: 0, perMessageDeflate: false });
  server.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw: Buffer) => {
      const read = readFrame(raw.toString('utf8'), INBOUND);
      if (read.kind !== 'frame') return;
      seen.push(read.t);
      if (read.t === 'hello') {
        socket.send(frame('welcome', {
          protocol: PROTOCOL, now: Date.now(),
          actor: { id: 'act_1', handle: 'harsh', display_name: 'Harsh Sharma' },
        }));
      }
      if (read.t === 'ping') socket.send(frame('pong'));
    });
  });
  await new Promise<void>(resolve => { server.on('listening', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  url = `ws://127.0.0.1:${port}/sync`;
});

after(async () => {
  await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
});

function connection(over: Record<string, unknown> = {}): Connection {
  const gate = installNetworkGate({ fetch: globalThis.fetch }, { allowOffline: true });
  gate.uninstall();
  return new Connection({
    url, gate,
    token: async () => 'tok',
    heartbeatMs: 40,
    readTimeoutMs: 500,
    helloTimeoutMs: 2_000,
    ...over,
  });
}

/**
 * Wait for something to become true, generously.
 *
 * Fifteen seconds rather than three, and the margin is not laziness. Every
 * property in this file is "eventually notices", never "notices within N" — the
 * deadlines that matter are asserted against a fake clock in `connection.test`.
 * At three seconds this passed alone and under the desktop suite, then failed
 * when `pnpm test` ran every package in parallel: a loaded event loop delayed a
 * socket close past the margin, and the failure said nothing about the code.
 *
 * A test whose margin is the thing under test measures the scheduler.
 */
const until = async (predicate: () => boolean, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 5));
  }
};

test('a real socket connects, handshakes and goes live', async () => {
  // The seam `defaultOpen` covers: no injected socket anywhere in this test.
  const link = connection();
  link.start();
  await until(() => link.state === 'live');
  assert.equal(seen.includes('hello'), true, 'the server received a real hello');
  link.stop();
});

test('a real welcome arrives as a Buffer and still parses', async () => {
  // `ws` delivers a Buffer, not a string. `String(raw)` is what bridges that,
  // and it is exactly the kind of line that looks obviously fine and would fail
  // as a silent handshake timeout.
  let got: unknown = null;
  const link = connection({ onWelcome: (body: unknown) => { got = body; } });
  link.start();
  await until(() => got !== null);
  assert.equal((got as { actor: { handle: string } }).actor.handle, 'harsh');
  link.stop();
});

test('the heartbeat round-trips over a real connection', async () => {
  const link = connection();
  link.start();
  await until(() => link.state === 'live');
  await until(() => seen.filter(t => t === 'ping').length >= 2);
  assert.equal(link.state, 'live', 'answered pings keep it up');
  link.stop();
});

test('a server that goes away is noticed, and the client backs off', async () => {
  // The close path, over a real socket rather than a method call.
  const own = new WebSocketServer({ port: 0, perMessageDeflate: false });
  own.on('connection', (socket: WebSocket) => {
    socket.on('message', () => {
      socket.send(frame('welcome', {
        protocol: PROTOCOL, now: Date.now(),
        actor: { id: 'act_1', handle: 'harsh', display_name: 'Harsh Sharma' },
      }));
    });
  });
  await new Promise<void>(resolve => { own.on('listening', resolve); });
  const address = own.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const link = connection({ url: `ws://127.0.0.1:${port}/sync` });
  link.start();
  await until(() => link.state === 'live');

  // Terminate the connections BEFORE closing the server, and in that order.
  // `close()` only calls back once every client has gone, so awaiting it while
  // one is still attached waits for something this test is about to do itself —
  // which is a deadlock, and was one until the ordering was reversed.
  //
  // `terminate` rather than `close`: a server that has gone away does not
  // perform a closing handshake, and the point is to look like a crash rather
  // than a polite goodbye.
  for (const client of own.clients) client.terminate();
  await until(() => link.state !== 'live');
  assert.equal(link.state, 'backoff', 'a dropped server is a retry, not a stop');

  link.stop();
  await new Promise<void>(resolve => { own.close(() => { resolve(); }); });
});

test('stop() actually closes the TCP connection', async () => {
  // A teardown must settle everything it abandons (invariant 54). Asserted from
  // the SERVER's side, because a client that merely forgets its socket looks
  // identical from the client's.
  let live = 0;
  const own = new WebSocketServer({ port: 0, perMessageDeflate: false });
  own.on('connection', (socket: WebSocket) => {
    live++;
    socket.on('close', () => { live--; });
    socket.on('message', () => {
      socket.send(frame('welcome', {
        protocol: PROTOCOL, now: Date.now(),
        actor: { id: 'act_1', handle: 'harsh', display_name: 'Harsh Sharma' },
      }));
    });
  });
  await new Promise<void>(resolve => { own.on('listening', resolve); });
  const address = own.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const link = connection({ url: `ws://127.0.0.1:${port}/sync` });
  link.start();
  await until(() => link.state === 'live');
  assert.equal(live, 1);

  link.stop();
  await until(() => live === 0);
  await new Promise<void>(resolve => { own.close(() => { resolve(); }); });
});
