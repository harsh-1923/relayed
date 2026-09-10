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
import { gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { frame, readFrame, OUTBOUND, CLOSE, PROTOCOL } from '@relayed/protocol';
import { sql } from 'kysely';
import { db, pool } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { attachSyncSocket, SYNC_PATH, type SyncSocket } from './socket.ts';
import { createChannel, addToSpace } from './spaces.ts';
import { send } from './ops.ts';
import type { SessionClaims } from '../auth/tokens.ts';

const reachable = await pool.query('SELECT 1').then(() => true).catch(() => false);
const opts = reachable ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const me = ulid('act');
const gone = ulid('act');
const outsider = ulid('act');   // in the workspace, in no space

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
  for (const [id, state] of
       [[me, 'active'], [gone, 'deactivated'], [outsider, 'active']] as const) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type: 'human',
      handle: `s-${id.slice(-6).toLowerCase()}`, display_name: 'Socket Test',
      avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${id}`,
      owner_actor_id: null, provisioned_by: 'api', state,
    }).execute();
    // can() needs the workspace conjunct above any space one (AUTHZ.md §7).
    await db.insertInto('memberships').values({
      scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member',
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
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
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
  assert.equal(sync.registry.forActors([me]).length, 2);
  first.socket.close();
  second.socket.close();
  await sleep(50);
  assert.equal(sync.registry.forActors([me]).length, 0, 'and both are released on close');
});

test('an unauthenticated connection belongs to no actor', opts, async () => {
  const peer = await connect();
  assert.equal(sync.registry.forActors([me]).length, 0);
  assert.ok(sync.size() >= 1, 'it is a connection, it is just nobody yet');
  peer.socket.close();
});

// ─── the upgrade ────────────────────────────────────────────────────────────

// ─── fanout, over a real connection ─────────────────────────────────────────

test('a committed event reaches a real socket, and only the right one',
  opts, async () => {
    // The seam the fanout tests cannot cover: they use a fake Delivery, so
    // nothing there proves that a real ConnectionState satisfies that interface
    // — that `workspaceId` comes off the verified claims, that `send` reaches
    // the wire, that `backlog` reads the socket rather than returning zero
    // forever. All four would fail identically and silently: events resolved,
    // audience correct, nothing delivered.
    const space = await createChannel(db, {
      workspaceId: wsp, name: `sock-${ulid('x')}`, createdBy: me,
    });

    const member = await connect();
    member.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
    await member.next('welcome');

    // `gone` is deactivated, so it cannot authenticate — a second live socket
    // for somebody outside the space needs a third actor.
    const outsiderPeer = await connect();
    outsiderPeer.send('hello', { protocol: PROTOCOL, access_token: `good:${outsider}` });
    await outsiderPeer.next('welcome');

    const { event } = await send(db, {
      opId: ulid('op'), chatId: space.chatId, actorId: me,
      messageId: ulid('msg'), body: 'over the wire',
    });
    const result = await sync.deliver(event!);

    assert.equal(result.audience, 1, 'only the space member is entitled');
    assert.equal(result.delivered, 1);

    const ev = await member.next('ev') as {
      stream: { kind: string; id: string }; type: string; payload: { body: string };
    };
    assert.deepEqual(ev.stream, { kind: 'chat', id: space.chatId });
    assert.equal(ev.type, 'message.created');
    assert.equal(ev.payload.body, 'over the wire');
    assert.equal(outsiderPeer.frames.some(f => f.t === 'ev'), false,
      'the outsider’s socket was open and received nothing');

    member.socket.close();
    outsiderPeer.socket.close();
  });

test('a closed socket leaves the registry, so fanout stops finding it',
  opts, async () => {
    // Removal happens on close AND on error. A registry that only shed
    // connections on a clean close would keep writing to sockets that errored,
    // and the leak's symptom is memory on the busiest server, months later.
    const peer = await connect();
    peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
    await peer.next('welcome');
    assert.equal(sync.registry.forActors([me]).length, 1);

    peer.socket.close();
    await peer.closed;
    await sleep(50);
    assert.equal(sync.registry.forActors([me]).length, 0);
  });

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

// ─── welcome carries the workspace ──────────────────────────────────────────

test('welcome carries joined spaces, chats with counters, and own memberships',
  opts, async () => {
    // R2, in one exchange. After this frame every badge in the sidebar is
    // correct — with the message tables on the client still empty, because
    // "I have it" and "I know it exists" are different facts.
    const space = await createChannel(db, {
      workspaceId: wsp, name: `w-${ulid('x')}`, createdBy: me,
    });
    // Joined FIRST, then posts. `can()` checks membership on the way in, so the
    // other order is a Forbidden rather than an unread message.
    await addToSpace(db, space.spaceId, outsider, me);
    await send(db, { opId: ulid('op'), chatId: space.chatId, actorId: outsider,
                     messageId: ulid('msg'), body: 'unread by me' });

    const peer = await connect();
    peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
    const body = await peer.next('welcome') as {
      spaces: { id: string; rev: number }[];
      chats: { id: string; chat_unread: number; head_rev: number }[];
      memberships: { scope_type: string; scope_id: string; role: string }[];
      streams: { kind: string; rev: number }[];
    };

    const mine = body.spaces.find(s => s.id === space.spaceId);
    assert.ok(mine, 'the space this actor joined');
    assert.ok(mine.rev > 0, 'with its stream cursor, so catch-up knows where to start');

    const chat = body.chats.find(c => c.id === space.chatId);
    assert.ok(chat, 'and its chat');
    assert.equal(chat.chat_unread, 1, 'a correct badge, before any body is fetched');
    assert.ok(chat.head_rev > 0);

    // The whole row, not a role comparison — `authz/no-role-comparison` caught
    // the first version of this line, and was right to: a role tested at a call
    // site is the pattern that drifts, and a deepEqual is a stronger assertion
    // anyway because it pins the shape the client parses.
    assert.deepEqual(
      body.memberships.find(m => m.scope_id === space.spaceId),
      { scope_type: 'space', scope_id: space.spaceId, role: 'admin' },
      'the caller’s own grants, in the shape can() reads');
    assert.deepEqual(body.streams.map(s => s.kind), ['workspace'],
      'no actor cursor: an actor is a delivery address, not a stream');

    peer.socket.close();
  });

test('welcome carries NO collection sized by the workspace', opts, async () => {
  // Invariant 71, asserted against a fixture large enough for the difference to
  // matter rather than by reading the code. Measured at 1,600 members the actor
  // directory was 345 KB — 69% of the frame, and the only term that grows
  // because the company hired somebody rather than because this person joined
  // something (DESIGN.md §9.9).
  const crowd = Array.from({ length: 300 }, () => ulid('act'));
  await db.insertInto('actors').values(crowd.map(id => ({
    id, org_id: org, workspace_id: wsp, type: 'human' as const,
    handle: `c-${id.slice(-10).toLowerCase()}`, display_name: 'Crowd',
    avatar_url: null, identity_kind: 'workos_user' as const, identity_id: `wu_${id}`,
    owner_actor_id: null, provisioned_by: 'api' as const, state: 'active' as const,
  }))).execute();
  await db.insertInto('memberships').values(crowd.map(id => ({
    scope_type: 'workspace' as const, scope_id: wsp, actor_id: id, role: 'member' as const,
  }))).execute();

  // ...and a pile of public channels this actor has NOT joined.
  for (let i = 0; i < 12; i++) {
    await createChannel(db, {
      workspaceId: wsp, name: `unjoined-${ulid('x')}`, createdBy: crowd[0] as string,
    });
  }

  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  const body = await peer.next('welcome') as Record<string, unknown>;

  assert.equal('actors' in body, false, 'the directory is a stream, not an array');
  const spaces = body['spaces'] as { id: string }[];
  const joined = await db.selectFrom('memberships').select('scope_id')
    .where('scope_type', '=', 'space').where('actor_id', '=', me)
    .where('left_at', 'is', null).execute();
  assert.equal(spaces.length, joined.length,
    'joined spaces only — public means discoverable, not synced');

  const memberships = body['memberships'] as { scope_id: string }[];
  assert.ok(memberships.length < 100,
    'the CALLER’s own memberships, not members × spaces');

  peer.socket.close();
});

test('a large welcome is compressed when the client says it can', opts, async () => {
  // One-shot, per frame — which is why it does not reopen the decision to leave
  // permessage-deflate off. That rule is about a zlib context held for the life
  // of every connection (~189 KB each); this allocates, compresses and frees.
  //
  // The frame is made genuinely large rather than the threshold made small. An
  // injectable limit would have tested that the branch runs; this tests that a
  // realistic workspace actually crosses it, which is the question — a
  // compression path that never triggers in production is not compression.
  for (let i = 0; i < 45; i++) {
    await createChannel(db, {
      workspaceId: wsp, name: `bulk-${ulid('x')}`, createdBy: me,
    });
  }

  const socket = new WebSocket(url);
  let binary = 0;
  let text = 0;
  const frames: { t: string; body: unknown }[] = [];
  socket.on('message', (raw: Buffer, isBinary: boolean) => {
    if (isBinary) { binary++; raw = gunzipSync(raw); } else { text++; }
    const read = readFrame(raw.toString('utf8'), OUTBOUND);
    if (read.kind === 'frame') frames.push({ t: read.t, body: read.body });
  });
  await new Promise<void>(resolve => { socket.on('open', () => resolve()); });

  socket.send(frame('hello', {
    protocol: PROTOCOL, access_token: `good:${me}`, compression: ['gzip'],
  }));
  const deadline = Date.now() + 3_000;
  while (!frames.some(f => f.t === 'welcome') && Date.now() < deadline) {
    await sleep(5);
  }

  const welcomeFrame = frames.find(f => f.t === 'welcome');
  assert.ok(welcomeFrame, 'and it still parses after the round trip');
  assert.equal(binary, 1, 'the large frame came back compressed');
  assert.equal(text, 0);
  socket.close();
});

test('a client that offers no compression gets plain text', opts, async () => {
  // Negotiated, not versioned. An older build that has never heard of the field
  // must keep working unchanged rather than being told it is too old for a
  // change that costs it nothing.
  const socket = new WebSocket(url);
  let binary = 0;
  let sawWelcome = false;
  socket.on('message', (raw: Buffer, isBinary: boolean) => {
    if (isBinary) binary++;
    if (!isBinary && raw.toString('utf8').includes('"welcome"')) sawWelcome = true;
  });
  await new Promise<void>(resolve => { socket.on('open', () => resolve()); });

  socket.send(frame('hello', { protocol: PROTOCOL, access_token: `good:${me}` }));
  const deadline = Date.now() + 3_000;
  while (!sawWelcome && Date.now() < deadline) await sleep(5);

  assert.ok(sawWelcome, 'a welcome arrived');
  assert.equal(binary, 0, 'and none of it was binary');
  socket.close();
});

// ─── catch-up and backfill ──────────────────────────────────────────────────

test('catch-up replays the events after a client’s frontier', opts, async () => {
  const space = await createChannel(db, {
    workspaceId: wsp, name: `cu-${ulid('x')}`, createdBy: me,
  });
  for (let i = 0; i < 4; i++) {
    await send(db, { opId: ulid('op'), chatId: space.chatId, actorId: me,
                     messageId: ulid('msg'), body: `m${i}` });
  }

  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');

  peer.send('catchup', { stream: { kind: 'chat', id: space.chatId }, from_rev: 2 });
  const reply = await peer.next('catchup_ok') as {
    from_rev: number; to_rev: number; complete: boolean;
    events: { rev: number; type: string }[];
  };

  assert.deepEqual(reply.events.map(e => e.rev), [3, 4], 'strictly after the frontier');
  assert.equal(reply.to_rev, 4, 'what the frontier becomes once this applies');
  assert.equal(reply.complete, true);
  peer.socket.close();
});

test('a far-behind client gets a GAP with a tail, not a replay', opts, async () => {
  // What bounds a reconnect to O(streams) rather than O(messages).
  const space = await createChannel(db, {
    workspaceId: wsp, name: `gap-${ulid('x')}`, createdBy: me,
  });
  // Cheaper than sending 600 messages: write the log directly and move the head.
  await sql`
    INSERT INTO sync_events
      (event_id, workspace_id, stream_kind, stream_id, stream_rev, event_type, payload)
    SELECT 'evt_gap_' || ${space.chatId} || '_' || n, ${wsp}, 'chat', ${space.chatId}, n,
           'message.created', '{"id":"m"}'::jsonb
      FROM generate_series(1, 900) n
  `.execute(db);
  await db.updateTable('chats').set({ next_rev: 900 })
    .where('id', '=', space.chatId).execute();
  await send(db, { opId: ulid('op'), chatId: space.chatId, actorId: me,
                   messageId: ulid('msg'), body: 'the newest' });

  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');

  peer.send('catchup', { stream: { kind: 'chat', id: space.chatId }, from_rev: 0 });
  const gap = await peer.next('gap') as {
    head_rev: number; snapshot: { kind: string; headOrd: number; recent: unknown[] };
  };

  assert.ok(gap.head_rev >= 900);
  assert.equal(gap.snapshot.kind, 'messages');
  assert.ok(gap.snapshot.recent.length <= 50, 'a bounded tail, not 900 events');
  peer.socket.close();
});

test('a gap on a SPACE stream is its current shape, not a message tail',
  opts, async () => {
    // The snapshot is discriminated by stream kind. A message tail is
    // meaningless for a stream that carries none — an earlier version returned
    // one for every stream.
    const space = await createChannel(db, {
      workspaceId: wsp, name: `sp-${ulid('x')}`, createdBy: me,
    });
    await db.updateTable('spaces').set({ next_rev: 900 })
      .where('id', '=', space.spaceId).execute();

    const peer = await connect();
    peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
    await peer.next('welcome');

    peer.send('catchup', { stream: { kind: 'space', id: space.spaceId }, from_rev: 0 });
    const gap = await peer.next('gap') as {
      snapshot: { kind: string; chats: { id: string }[]; members: string[] };
    };

    assert.equal(gap.snapshot.kind, 'space');
    assert.deepEqual(gap.snapshot.chats.map(c => c.id), [space.chatId]);
    assert.deepEqual(gap.snapshot.members, [me]);
    peer.socket.close();
  });

test('catch-up on a stream the actor cannot read is answered with SILENCE',
  opts, async () => {
    // Never inferred from the cursor — a modified client can send any id. And
    // silence rather than a denial: telling an actor that a stream exists but is
    // not theirs is a disclosure, telling them nothing is not.
    const theirs = await createChannel(db, {
      workspaceId: wsp, name: `priv-${ulid('x')}`, visibility: 'private',
      createdBy: outsider,
    });

    const peer = await connect();
    peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
    await peer.next('welcome');

    peer.send('catchup', { stream: { kind: 'chat', id: theirs.chatId }, from_rev: 0 });
    peer.send('ping');
    await peer.next('pong');   // a later frame proves the connection survived

    assert.equal(peer.frames.some(f => f.t === 'catchup_ok' || f.t === 'gap'), false,
      'nothing was said about a chat this actor cannot see');
    assert.equal(peer.socket.readyState, peer.socket.OPEN);
    peer.socket.close();
  });

test('a stream KIND this server does not have is ignored, not fatal', opts, async () => {
  // A newer client naming a stream kind this deployment predates must not be an
  // error. Without the guard this fell through to the workspace branch of the
  // head lookup, so `banana:spc_1` would have been answered about a workspace.
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');

  peer.send('catchup', { stream: { kind: 'banana', id: 'nonsense' }, from_rev: 0 });
  peer.send('ping');
  await peer.next('pong');

  assert.equal(peer.frames.some(f => f.t === 'gap' || f.t === 'catchup_ok'), false);
  assert.equal(peer.socket.readyState, peer.socket.OPEN);
  peer.socket.close();
});

test('backfill pages history below an ordinal, keyset and complete-flagged',
  opts, async () => {
    const space = await createChannel(db, {
      workspaceId: wsp, name: `bf-${ulid('x')}`, createdBy: me,
    });
    for (let i = 0; i < 7; i++) {
      await send(db, { opId: ulid('op'), chatId: space.chatId, actorId: me,
                       messageId: ulid('msg'), body: `m${i}` });
    }

    const peer = await connect();
    peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
    await peer.next('welcome');

    peer.send('backfill', { c: space.chatId, before_ord: 6, limit: 3 });
    const page = await peer.next('backfill_ok') as {
      rows: { ord: number }[]; complete: boolean;
    };

    assert.deepEqual(page.rows.map(r => r.ord), [5, 4, 3], 'newest first, below the cursor');
    assert.equal(page.complete, false, 'a full page means there may be more');
    peer.socket.close();
  });

test('a short backfill page reports complete, so paging terminates', opts, async () => {
  const space = await createChannel(db, {
    workspaceId: wsp, name: `bfc-${ulid('x')}`, createdBy: me,
  });
  for (let i = 0; i < 3; i++) {
    await send(db, { opId: ulid('op'), chatId: space.chatId, actorId: me,
                     messageId: ulid('msg'), body: `m${i}` });
  }

  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');

  peer.send('backfill', { c: space.chatId, before_ord: 3, limit: 50 });
  const page = await peer.next('backfill_ok') as { rows: unknown[]; complete: boolean };
  assert.equal(page.rows.length, 2);
  assert.equal(page.complete, true, 'derived from the short page, not asked for');
  peer.socket.close();
});

// ─── the directory, paged ───────────────────────────────────────────────────

test('the directory pages by actor id, keyset and complete-flagged', opts, async () => {
  // Keyset, never OFFSET. Actors have no ordinal, but ULIDs sort — so the
  // primary key already gives a stable order, and offset paging would skip or
  // repeat rows when somebody joins mid-fetch. For a directory that means an
  // author silently missing from a client that paged past them.
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');

  peer.send('directory', { after_id: null, limit: 2 });
  const first = await peer.next('directory_ok') as {
    rows: { id: string }[]; next_after_id: string | null;
    complete: boolean; head_rev: number;
  };

  assert.equal(first.rows.length, 2);
  assert.equal(first.complete, false, 'a full page means there may be more');
  assert.equal(first.next_after_id, first.rows[1]?.id, 'the cursor is the last id');
  assert.ok(first.rows[0]!.id < first.rows[1]!.id, 'ordered, so paging is stable');
  peer.socket.close();
});

test('a directory page carries no Layer 1 identity reference', opts, async () => {
  // `identity_kind` and `identity_id` are deliberately not selected. Nothing on
  // the client addresses an actor by anything but `actor_id`, and sending them
  // would hand every member a directory of everyone else's external
  // identifiers for no feature (invariant 16).
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');

  peer.send('directory', { after_id: null, limit: 5 });
  const page = await peer.next('directory_ok') as { rows: Record<string, unknown>[] };

  for (const row of page.rows) {
    for (const forbidden of ['identity_kind', 'identity_id', 'workos_user_id']) {
      assert.equal(forbidden in row, false, `a directory row leaked ${forbidden}`);
    }
  }
  peer.socket.close();
});

test('a DEACTIVATED actor is in the directory, not omitted from it', opts, async () => {
  // A tombstoned author still has to render on the messages they wrote. A
  // client that dropped them would show an empty name where a greyed one
  // belongs (DESIGN.md §6.3).
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');

  peer.send('directory', { after_id: null, limit: 1000 });
  const page = await peer.next('directory_ok') as {
    rows: { id: string; state: string }[];
  };

  const tombstoned = page.rows.find(r => r.id === gone);
  assert.ok(tombstoned, 'the deactivated actor is present');
  assert.equal(tombstoned.state, 'deactivated', 'and says so, so it can be greyed');
  peer.socket.close();
});

test('the directory is scoped by the TOKEN, never by a parameter', opts, async () => {
  // A workspace id in a request is not evidence of membership in it. That is
  // the whole of the authorization here — and it is enough, because every
  // member of a workspace is entitled to all of its directory, which is exactly
  // why the directory can be a workspace-wide stream at all (DESIGN.md §9.9).
  const otherOrg = ulid('org');
  const otherWsp = ulid('wsp');
  const stranger = ulid('act');
  await db.insertInto('organizations')
    .values({ id: otherOrg, workos_org_id: `test_${otherOrg}`, name: 'Other' }).execute();
  await db.insertInto('workspaces')
    .values({ id: otherWsp, org_id: otherOrg, name: 'Other',
              slug: `o-${otherWsp.slice(-6).toLowerCase()}` }).execute();
  await db.insertInto('actors').values({
    id: stranger, org_id: otherOrg, workspace_id: otherWsp, type: 'human',
    handle: 'stranger', display_name: 'Stranger', avatar_url: null,
    identity_kind: 'workos_user', identity_id: `wu_${stranger}`,
    owner_actor_id: null, provisioned_by: 'api', state: 'active' }).execute();

  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');
  peer.send('directory', { after_id: null, limit: 1000, workspace_id: otherWsp });
  const page = await peer.next('directory_ok') as { rows: { id: string }[] };

  assert.equal(page.rows.some(r => r.id === stranger), false,
    'the workspace_id in the request was ignored');
  peer.socket.close();
  await db.deleteFrom('organizations').where('id', '=', otherOrg).execute();
});

test('head_rev rides along, so a completed snapshot knows its cursor', opts, async () => {
  // Read BEFORE the page rather than after: taken afterwards it could be higher
  // than the data, and a client adopting it would jump its frontier past a
  // change the page did not contain.
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');

  peer.send('directory', { after_id: null, limit: 1000 });
  const page = await peer.next('directory_ok') as { head_rev: number; complete: boolean };
  assert.equal(page.complete, true);
  assert.equal(typeof page.head_rev, 'number');
  peer.socket.close();
});

// ─── writes ─────────────────────────────────────────────────────────────────

test('an op is acked to the sender AND fanned out as an event', opts, async () => {
  // Both, deliberately. The ack reconciles the sender's outbox row; the event
  // travels the same apply path as on every other device, so there is one
  // convergence mechanism rather than a special case for "mine".
  const space = await createChannel(db, {
    workspaceId: wsp, name: `op-${ulid('x')}`, createdBy: me,
  });
  await addToSpace(db, space.spaceId, outsider, me);

  const author = await connect();
  author.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await author.next('welcome');
  const other = await connect();
  other.send('hello', { protocol: PROTOCOL, access_token: `good:${outsider}` });
  await other.next('welcome');

  const opId = ulid('op');
  const messageId = ulid('msg');
  author.send('op', {
    op_id: opId, kind: 'send', c: space.chatId, target: messageId,
    m: { parent_id: null, body: 'over the wire' },
  });

  const ack = await author.next('ack') as {
    op_id: string; id: string; ord: number; rev: number; created_at: string;
  };
  assert.equal(ack.op_id, opId);
  assert.equal(ack.id, messageId);
  assert.equal(ack.ord, 1);

  const ev = await other.next('ev') as { payload: { body: string; created_at: string } };
  assert.equal(ev.payload.body, 'over the wire');
  assert.equal(ev.payload.created_at, ack.created_at,
    'the same timestamp — one message must not render at two different times');

  author.socket.close();
  other.socket.close();
});

test('a RETRIED op returns the same ack and fans out nothing new', opts, async () => {
  // The single most common offline-sync bug: send, lose the connection before
  // the ack, retry, and get two messages. The ledger returns the stored ack,
  // and the absent event is what stops every OTHER device seeing a duplicate.
  const space = await createChannel(db, {
    workspaceId: wsp, name: `rt-${ulid('x')}`, createdBy: me,
  });
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');

  const opId = ulid('op');
  const messageId = ulid('msg');
  const op = {
    op_id: opId, kind: 'send', c: space.chatId, target: messageId,
    m: { parent_id: null, body: 'once' },
  };
  peer.send('op', op);
  const first = await peer.next('ack') as { ord: number; rev: number };

  peer.send('op', op);
  const deadline = Date.now() + 1_000;
  while (peer.frames.filter(f => f.t === 'ack').length < 2 && Date.now() < deadline) {
    await sleep(5);
  }

  const acks = peer.frames.filter(f => f.t === 'ack')
    .map(f => f.body as { ord: number; rev: number });
  assert.equal(acks.length, 2, 'both were answered');
  assert.deepEqual(acks[1], acks[0], 'with the SAME ordinal, not a second one');
  assert.equal(peer.frames.filter(f => f.t === 'ev').length, 1,
    'and the replay fanned out nothing');
  void first;

  const rows = await db.selectFrom('messages').select('id')
    .where('chat_id', '=', space.chatId).execute();
  assert.equal(rows.length, 1, 'one message, not two');
  peer.socket.close();
});

test('a delete over the wire acks with a rev and NO ordinal', opts, async () => {
  // The two-counter model reaching the wire: a delete takes a revision and no
  // ordinal, so nothing is renumbered and the gap it leaves is normal.
  const space = await createChannel(db, {
    workspaceId: wsp, name: `del-${ulid('x')}`, createdBy: me,
  });
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');

  const messageId = ulid('msg');
  peer.send('op', {
    op_id: ulid('op'), kind: 'send', c: space.chatId, target: messageId,
    m: { parent_id: null, body: 'doomed' },
  });
  const sent = await peer.next('ack') as { ord: number; rev: number };

  peer.send('op', { op_id: ulid('op'), kind: 'delete', c: space.chatId, target: messageId });
  const deadline = Date.now() + 2_000;
  while (peer.frames.filter(f => f.t === 'ack').length < 2 && Date.now() < deadline) {
    await sleep(5);
  }
  const acks = peer.frames.filter(f => f.t === 'ack')
    .map(f => f.body as { ord: number | null; rev: number });

  assert.equal(acks[1]?.ord, null, 'no ordinal');
  assert.ok((acks[1]?.rev ?? 0) > sent.rev, 'but the revision advanced');
  peer.socket.close();
});

test('a write into a chat the actor cannot reach is a NON-retryable nack',
  opts, async () => {
    // It will never succeed. Retrying it silently for ever is worse than an
    // error, because the person sees a message that looks queued and never
    // learns it will not go.
    const theirs = await createChannel(db, {
      workspaceId: wsp, name: `no-${ulid('x')}`, visibility: 'private',
      createdBy: outsider,
    });
    const peer = await connect();
    peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
    await peer.next('welcome');

    peer.send('op', {
      op_id: ulid('op'), kind: 'send', c: theirs.chatId, target: ulid('msg'),
      m: { parent_id: null, body: 'not mine to send' },
    });
    const nack = await peer.next('nack') as {
      code: string; retryable: boolean; message: string;
    };

    assert.equal(nack.retryable, false, 'permanent, so the client stops');
    assert.equal(nack.code, 'forbidden');
    assert.ok(nack.message.length > 0, 'and says something a person can read');
    assert.equal(peer.socket.readyState, peer.socket.OPEN, 'the connection survives');
    peer.socket.close();
  });

test('deleting a message that does not exist is a non-retryable nack', opts, async () => {
  const space = await createChannel(db, {
    workspaceId: wsp, name: `nf-${ulid('x')}`, createdBy: me,
  });
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');

  peer.send('op', {
    op_id: ulid('op'), kind: 'delete', c: space.chatId, target: 'msg_never_existed',
  });
  const nack = await peer.next('nack') as { code: string; retryable: boolean };
  assert.equal(nack.code, 'not_found');
  assert.equal(nack.retryable, false);
  peer.socket.close();
});

// ─── the residue we accept, measured ────────────────────────────────────────

test('THE COMMIT-TO-SOCKET RESIDUE: a lost event is exposed by the next heartbeat',
  opts, async () => {
    // The one hole in delivering fanout in-process, closed to within a heartbeat
    // rather than asserted away.
    //
    // Fanout runs after the transaction commits, so a server that dies between
    // `COMMIT` and the socket write leaves an event durable and undelivered. It
    // mostly self-repairs — the next event in that stream lands above the
    // client's frontier and triggers catch-up — but the LAST event before a
    // silence has nothing after it to expose it. A quiet chat would sit one
    // message behind until somebody happened to post.
    //
    // Simulated by committing WITHOUT fanning out, which is exactly the state a
    // crash in that window leaves behind.
    const space = await createChannel(db, {
      workspaceId: wsp, name: `res-${ulid('x')}`, createdBy: me,
    });

    const peer = await connect();
    peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
    await peer.next('welcome');

    // The event that never reaches the socket.
    await send(db, {
      opId: ulid('op'), chatId: space.chatId, actorId: me,
      messageId: ulid('msg'), body: 'lost between commit and write',
    });
    await sleep(50);
    assert.equal(peer.frames.some(f => f.t === 'ev'), false,
      'nothing was delivered — this is the hole');

    // The client's next heartbeat carries where it thinks it is.
    peer.send('ping', { cursors: [{ kind: 'chat', id: space.chatId, rev: 0 }] });
    const pong = await peer.next('pong') as {
      behind?: { kind: string; id: string; rev: number }[];
    };

    assert.deepEqual(pong.behind, [{ kind: 'chat', id: space.chatId, rev: 1 }],
      'the heartbeat says the server is ahead, so catch-up is triggered');
    peer.socket.close();
  });

test('a caught-up client gets an EMPTY pong, so the frame stays small', opts, async () => {
  // One of these per connection every twenty-five seconds. A reply that listed
  // every stream regardless would be a steady-state cost paid by everybody to
  // tell almost all of them nothing.
  const space = await createChannel(db, {
    workspaceId: wsp, name: `lvl-${ulid('x')}`, createdBy: me,
  });
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  const welcome = await peer.next('welcome') as {
    chats: { id: string; head_rev: number }[];
  };
  const head = welcome.chats.find(c => c.id === space.chatId)?.head_rev ?? 0;

  peer.send('ping', { cursors: [{ kind: 'chat', id: space.chatId, rev: head }] });
  const pong = await peer.next('pong') as { behind?: unknown[] };
  assert.equal(pong.behind, undefined, 'level, so nothing is listed');
  peer.socket.close();
});

test('a heartbeat with no cursors is still answered', opts, async () => {
  // Older clients send a bare ping. It must stay a liveness check rather than
  // becoming an error, or adding cursors would have broken every client in the
  // field for a change that costs them nothing.
  const peer = await connect();
  peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
  await peer.next('welcome');
  peer.send('ping');
  await peer.next('pong');
  assert.equal(peer.socket.readyState, peer.socket.OPEN);
  peer.socket.close();
});

test('a heartbeat naming a stream kind we do not have is ignored, not fatal',
  opts, async () => {
    const peer = await connect();
    peer.send('hello', { protocol: PROTOCOL, access_token: `good:${me}` });
    await peer.next('welcome');
    peer.send('ping', { cursors: [{ kind: 'banana', id: 'nope', rev: 0 }] });
    const pong = await peer.next('pong') as { behind?: unknown[] };
    assert.equal(pong.behind, undefined);
    assert.equal(peer.socket.readyState, peer.socket.OPEN);
    peer.socket.close();
  });
