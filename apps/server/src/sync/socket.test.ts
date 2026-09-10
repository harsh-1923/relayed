// The socket's server half, against a real HTTP server and a real `ws` client.
//
// Driven through an actual connection rather than by calling handlers, because
// every property worth asserting here is about the CONNECTION — that it stays
// open through a frame it does not understand, that it closes when a peer goes
// quiet, that a close code says which of several things went wrong. None of
// those survive being mocked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import WebSocket from 'ws';
import { frame, readFrame, OUTBOUND, CLOSE, PROTOCOL } from '@relayed/protocol';
import { db, pool } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { attachSyncSocket, SYNC_PATH, type SyncSocket } from './socket.ts';
import type { SessionClaims } from '../auth/tokens.ts';

const reachable = await pool.query('SELECT 1').then(() => true).catch(() => false);
const opts = reachable ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const me = ulid('act');
const gone = ulid('act');

/** A stand-in for the real verifier: no signing key, same contract. */
const claimsFor = (actorId: string): SessionClaims => ({
  actorId, workspaceId: wsp, orgId: org,
  deviceId: 'dev_test', sessionId: 'ses_test',
});
const verify = async (token: string): Promise<SessionClaims> => {
  if (!token.startsWith('good:')) throw new Error('bad token');
  return claimsFor(token.slice('good:'.length));
};

let server: Server;
let sync: SyncSocket;
let url: string;

before(async () => {
  if (!reachable) return;
  await db.insertInto('organizations')
    .values({ id: org, workos_org_id: `test_${org}`, name: 'Socket' }).execute();
  await db.insertInto('workspaces')
    .values({ id: wsp, org_id: org, name: 'Socket', slug: `s-${wsp.slice(-6).toLowerCase()}` })
    .execute();
  for (const [id, state] of [[me, 'active'], [gone, 'deactivated']] as const) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type: 'human',
      handle: `s-${id.slice(-6).toLowerCase()}`, display_name: 'Socket Test',
      avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${id}`,
      owner_actor_id: null, provisioned_by: 'api', state,
    }).execute();
  }

  server = createServer();
  // Short deadlines: the property is that a deadline EXISTS and fires, and a
  // test that waited ten real seconds to prove it would be deleted by the third
  // person who ran the suite.
  sync = attachSyncSocket(server, { db, verify, helloTimeoutMs: 150, readTimeoutMs: 250 });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  url = `ws://127.0.0.1:${port}${SYNC_PATH}`;
});

after(async () => {
  if (!reachable) return;
  await sync.close();
  await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** A connected client, with the frames it has received. */
async function connect(target = url): Promise<Peer> {
  const socket = new WebSocket(target);
  const frames: { t: string; body: unknown }[] = [];
  const closed = new Promise<{ code: number; reason: string }>(resolve => {
    socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  socket.on('message', (raw: Buffer) => {
    const read = readFrame(raw.toString('utf8'), OUTBOUND);
    if (read.kind === 'frame') frames.push({ t: read.t, body: read.body });
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });

  return {
    socket, frames, closed,
    send: (t, body) => { socket.send(frame(t, body)); },
    async next(t) {
      const deadline = Date.now() + 2_000;
      for (;;) {
        const found = frames.find(f => f.t === t);
        if (found) return found.body;
        if (Date.now() > deadline) throw new Error(`no ${t} frame within 2s`);
        await new Promise(r => setTimeout(r, 5));
      }
    },
  };
}

interface Peer {
  socket: WebSocket;
  frames: { t: string; body: unknown }[];
  closed: Promise<{ code: number; reason: string }>;
  send(t: string, body?: Record<string, unknown>): void;
  next(t: string): Promise<unknown>;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── the handshake ──────────────────────────────────────────────────────────

test('hello with a good token is answered with welcome', opts, async () => {
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  const welcome = await peer.next('welcome') as {
    protocol: number; now: number; actor: { id: string; handle: string };
  };

  assert.equal(welcome.protocol, PROTOCOL);
  assert.equal(welcome.actor.id, me);
  // `now` is not decoration: a client compares it with its own clock to compute
  // skew, and a badly wrong clock otherwise produces confusing timestamps
  // everywhere with nothing pointing at the cause (DESIGN §13.7).
  assert.ok(Math.abs(welcome.now - Date.now()) < 5_000, 'a usable server clock');
  peer.socket.close();
});

test('the actor comes from the TOKEN, not from anything the client said',
  opts, async () => {
    // A client that could name its own actor could name somebody else's. The
    // frame has no field for it, so this asserts the server does not invent one
    // from a field a future version might add back.
    const peer = await connect();
    peer.send('hello', {
      protocol: PROTOCOL, access_token: `good:${me}`,
      actor_id: gone, workspace_id: 'wsp_someone_elses',
    });
    const welcome = await peer.next('welcome') as { actor: { id: string } };
    assert.equal(welcome.actor.id, me, 'the token won');
    peer.socket.close();
  });

test('a bad token closes with `unauthenticated`, and says so', opts, async () => {
  // A close CODE rather than an error frame, so the client's reconnect logic
  // can tell "refresh your token" from "the server went away" without parsing.
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: 'nonsense' });
  const { code } = await peer.closed;
  assert.equal(code, CLOSE.unauthenticated);
});

test('a valid token for a DEACTIVATED actor is still refused', opts, async () => {
  // The token proves who signed it, not that the actor is still allowed in.
  // Tokens outlive deactivation by their whole TTL, so the row decides — which
  // means the socket must read it rather than trust the claims.
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${gone}` });
  const { code } = await peer.closed;
  assert.equal(code, CLOSE.unauthenticated);
});

test('a protocol below the floor gets `too_old` BEFORE the close', opts, async () => {
  // Built a year before anything can trigger it, because the moment it is
  // needed is the moment it cannot be shipped: the clients that would have to
  // understand it are precisely the old ones.
  const peer = await connect();
  peer.send('hello', { protocol: 0, access_token: `good:${me}` });
  const body = await peer.next('too_old') as { min_protocol: number; message: string };
  assert.equal(body.min_protocol, 1);
  assert.match(body.message, /update/i, 'a message a human can act on');
  const { code } = await peer.closed;
  assert.equal(code, CLOSE.tooOld);
});

test('a connection that never says hello is closed on its deadline', opts, async () => {
  // Every state that waits on the outside world carries a deadline (invariant
  // 64). This is the one an anonymous peer controls the timing of, so without
  // it, opening sockets and saying nothing is a free way to hold server memory.
  const peer = await connect();
  const { code } = await peer.closed;
  assert.equal(code, CLOSE.helloTimeout);
});

test('pinging without a hello does NOT extend the anonymous deadline', opts, async () => {
  // The subtle one. If any frame reset the deadline, a peer could ping forever
  // and never authenticate — a deadline that anything can postpone is not a
  // deadline.
  const peer = await connect();
  const stop = Date.now() + 400;
  const pinger = (async () => {
    while (Date.now() < stop && peer.socket.readyState === peer.socket.OPEN) {
      peer.send('ping');
      await sleep(30);
    }
  })();
  const { code } = await peer.closed;
  await pinger;
  assert.equal(code, CLOSE.helloTimeout, 'closed on schedule despite the traffic');
});

// ─── staying alive ──────────────────────────────────────────────────────────

test('ping is answered with pong', opts, async () => {
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');
  peer.send('ping');
  await peer.next('pong');
  peer.socket.close();
});

test('an authenticated peer that goes silent is closed', opts, async () => {
  // A socket that is open but dead is indistinguishable from a quiet one
  // without this, and everything it holds is never released (invariant 29).
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');
  const { code } = await peer.closed;
  assert.equal(code, CLOSE.goingAway);
});

test('a peer that keeps pinging is NOT closed', opts, async () => {
  // The other half, and the one that fails if the deadline is armed but never
  // re-armed — which would look fine in every test that does not wait.
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');

  let closedEarly = false;
  void peer.closed.then(() => { closedEarly = true; });
  for (let i = 0; i < 8; i++) { peer.send('ping'); await sleep(60); }

  assert.equal(closedEarly, false, 'survived past twice the read deadline');
  assert.ok(peer.frames.filter(f => f.t === 'pong').length >= 8);
  peer.socket.close();
});

// ─── the rules that keep old clients working ───────────────────────────────

test('an UNKNOWN frame type is ignored and the connection stays open',
  opts, async () => {
    // Invariant 43, from the server's side, and the test that protects every
    // future client: a newer client sending a frame this deployment predates
    // must not be disconnected, or every rollout is a partial outage for
    // whoever updated first.
    const peer = await connect();
    peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
    await peer.next('welcome');

    peer.send('reaction.added', { id: 'rct_1' });
    peer.send('subscribe', { channel: 'everything' });
    peer.send('ping');
    await peer.next('pong');

    assert.equal(peer.socket.readyState, peer.socket.OPEN);
    peer.socket.close();
  });

test('a MALFORMED frame is ignored and the connection stays open', opts, async () => {
  // Counted, not closed. A malformed frame is one frame; the connection behind
  // it may be healthy, and dropping it turns a client bug into a reconnect
  // storm against a server that is already unhappy about something.
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');

  peer.socket.send('{not json at all');
  peer.socket.send(JSON.stringify({ no: 'frame type' }));
  peer.socket.send(JSON.stringify({ t: 'ping', extra: { deeply: { nested: 1 } } }));
  await peer.next('pong');

  assert.equal(peer.socket.readyState, peer.socket.OPEN);
  peer.socket.close();
});

test('a second hello changes nothing', opts, async () => {
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${gone}` });
  peer.send('ping');
  await peer.next('pong');

  assert.equal(peer.frames.filter(f => f.t === 'welcome').length, 1,
    'not re-authenticated as somebody else');
  peer.socket.close();
});

// ─── the registry ───────────────────────────────────────────────────────────

test('two devices for one actor are two connections under one id', opts, async () => {
  // Keyed by actor rather than by device, which is what makes multi-device work
  // with no special case: both receive everything that actor may see.
  const first = await connect();
  const second = await connect();
  for (const peer of [first, second]) {
    peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
    await peer.next('welcome');
  }
  assert.equal(sync.forActor(me).length, 2);
  first.socket.close();
  second.socket.close();
  await sleep(50);
  assert.equal(sync.forActor(me).length, 0, 'and both are released on close');
});

test('an unauthenticated connection belongs to no actor', opts, async () => {
  const peer = await connect();
  assert.equal(sync.forActor(me).length, 0);
  assert.ok(sync.size() >= 1, 'it is a connection, it is just nobody yet');
  peer.socket.close();
});

// ─── the upgrade ────────────────────────────────────────────────────────────

test('an upgrade on any other path is refused', opts, async () => {
  // Refused at the handshake rather than accepted and closed after, so a
  // mistyped path fails loudly at connect time instead of looking like a
  // server that hangs up for no reason.
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await assert.rejects(() => connect(`ws://127.0.0.1:${port}/not-sync`));
});

test('closing the server tells every client WHY', opts, async () => {
  // A deploy that just drops connections leaves each client discovering it at
  // its next heartbeat — up to a minute of silence that looks exactly like a
  // network fault. This is the half of a restart that we control.
  const own = createServer();
  const ownSync = attachSyncSocket(own, { db, verify, helloTimeoutMs: 5_000, readTimeoutMs: 5_000 });
  await new Promise<void>(resolve => { own.listen(0, '127.0.0.1', resolve); });
  const address = own.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const peer = await connect(`ws://127.0.0.1:${port}${SYNC_PATH}`);
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');

  await ownSync.close();
  const { code } = await peer.closed;
  assert.equal(code, CLOSE.goingAway);
  await new Promise<void>(resolve => { own.close(() => { resolve(); }); });
});
