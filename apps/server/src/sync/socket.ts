// The socket, server half — step 5 of the sync build plan (docs/SYNC-FLOWS.md §2).
//
// Deliberately carrying no product meaning yet. It accepts a connection,
// authenticates it, keeps it alive, and ignores frames it does not understand.
// Fanout, cursors and `welcome`'s real payload are later steps, and separating
// them is what keeps the next failure attributable to one thing rather than to
// "sync is broken".
//
// AUTHENTICATION HAPPENS ON `hello`, NOT ON THE UPGRADE. A browser WebSocket
// cannot set request headers, and putting a token in the query string writes it
// into every access log and proxy trace between here and the client. The cost
// of authenticating a frame later is that an unauthenticated socket exists for
// a moment — which is why it carries a deadline it cannot talk its way out of.
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Kysely } from 'kysely';
import {
  readFrame, frame, INBOUND, PROTOCOL, MIN_PROTOCOL, CLOSE,
  type Hello,
} from '@relayed/protocol';
import type { DB } from '../db/schema.ts';
import { verifyAccessToken, type SessionClaims } from '../auth/tokens.ts';
import { Registry, type Delivery } from './registry.ts';
import { fanout, type FanoutResult } from './fanout.ts';
import type { AppendedEvent } from './events.ts';

/** Where the socket lives. One path; the protocol is negotiated in `hello`. */
export const SYNC_PATH = '/sync';

/**
 * How long an unauthenticated socket may exist.
 *
 * Every state that waits on the outside world carries a deadline (invariant
 * 64), and this is the one state an anonymous peer controls the timing of.
 * Without it, opening sockets and never speaking is a free way to hold server
 * memory.
 */
const HELLO_TIMEOUT_MS = 10_000;

/**
 * How long an authenticated socket may be silent before it is presumed dead.
 *
 * Twice the client's heartbeat interval plus slack, so a single dropped ping is
 * survivable and two are not. A socket that is open but dead is
 * indistinguishable from a quiet one without this, and the resources it holds
 * are never released (invariant 29).
 */
const READ_TIMEOUT_MS = 70_000;

export interface SocketDeps {
  db: Kysely<DB>;
  /** Injected so a test does not need a signing key, and nothing else does. */
  verify?: (token: string) => Promise<SessionClaims>;
  helloTimeoutMs?: number;
  readTimeoutMs?: number;
  /** Called for anything worth a metric. Wired to telemetry in the marker pass. */
  onEvent?: (name: string, detail?: Record<string, unknown>) => void;
}

export interface SyncSocket {
  /** Every connection, authenticated or not. */
  size(): number;
  /** Authenticated connections only, keyed by actor rather than by device. */
  registry: Registry;
  /**
   * Deliver one committed event to whoever is entitled to it.
   *
   * Bound to this socket's registry and database so a caller needs neither.
   * MUST be called after the transaction that produced the event has committed
   * — publishing from inside one means a rollback has already told every client
   * about something that never happened.
   */
  deliver(event: AppendedEvent): Promise<FanoutResult>;
  close(): Promise<void>;
}

export function attachSyncSocket(server: Server, deps: SocketDeps): SyncSocket {
  const verify = deps.verify ?? verifyAccessToken;
  const helloTimeoutMs = deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const readTimeoutMs = deps.readTimeoutMs ?? READ_TIMEOUT_MS;
  const note = deps.onEvent ?? (() => {});

  // `noServer` rather than `{ server }`: we want to refuse an upgrade on any
  // other path outright rather than accept it and close it afterwards, and that
  // decision has to happen before the handshake completes.
  const wss = new WebSocketServer({
    noServer: true,
    // Left off deliberately (invariant 28). It looks free and costs ~189 KB of
    // zlib context per connection — about 17× the connection itself — for
    // negligible gain on sub-1 KB JSON. This is the line someone eventually
    // "optimises"; the number is why they should not.
    perMessageDeflate: false,
  });

  // Two collections, and the split is deliberate. Every socket is in
  // `connections` from the moment it opens, so an anonymous one still has a
  // deadline and still gets closed on shutdown. Only an AUTHENTICATED one joins
  // the registry, because the registry is keyed by actor and an anonymous
  // socket has no actor to key it by.
  const connections = new Set<ConnectionState>();
  const registry = new Registry();

  server.on('upgrade', (request, socket, head) => {
    // `request.url` is a path, not an absolute URL, so it needs a base to be
    // parsed. Query strings are ignored: nothing may be authenticated from one.
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== SYNC_PATH) {
      // Destroyed rather than answered. Another upgrade handler on this server
      // would never see it either way, and there is only one.
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => { accept(ws); });
  });

  function accept(socket: WebSocket): void {
    const state = new ConnectionState(socket);
    connections.add(state);

    // The anonymous deadline. Reset only by `hello` succeeding, never by any
    // other frame — otherwise pinging forever would be a way to stay connected
    // without ever authenticating.
    state.arm(helloTimeoutMs, () => {
      note('sync.socket.hello_timeout');
      state.bye(CLOSE.helloTimeout, 'no hello');
    });

    const forget = (): void => {
      state.dispose();
      connections.delete(state);
      // Removed on BOTH paths. A registry that only shed connections on a clean
      // close would keep writing to sockets that errored — and that leak's
      // symptom is memory on the busiest server, months later.
      if (state.claims) registry.remove(state);
    };
    socket.on('message', (raw: Buffer) => { void onMessage(state, raw); });
    socket.on('error', forget);
    socket.on('close', forget);
  }

  async function onMessage(state: ConnectionState, raw: Buffer): Promise<void> {
    const read = readFrame(raw.toString('utf8'), INBOUND);

    if (read.kind === 'ignored') {
      // Invariant 43 from the server's side. A newer client sending a frame
      // this deployment predates must not have its connection dropped — that
      // would make every rollout a partial outage for whoever updated first.
      note('sync.frame.unknown', { t: read.t });
      return;
    }
    if (read.kind === 'malformed') {
      // Counted, not closed. A malformed frame is one frame; the connection
      // behind it may be perfectly healthy, and dropping it turns a client bug
      // into a reconnect storm.
      note('sync.frame.malformed', { reason: read.reason });
      return;
    }

    if (read.t === 'hello') { await onHello(state, read.body as Hello); return; }

    // Everything past here needs an authenticated connection. Silence rather
    // than an error frame: a peer that has not said hello is a peer we know
    // nothing about, and the deadline is already dealing with it.
    if (!state.claims) return;
    state.arm(readTimeoutMs, () => {
      note('sync.socket.read_timeout');
      state.bye(CLOSE.goingAway, 'silent');
    });

    if (read.t === 'ping') {
      // The heartbeat is CLIENT-initiated, which is one mechanism serving both
      // directions: the client learns the server is alive from this reply, and
      // the server learns the client is alive from the ping that caused it.
      //
      // The step that adds fanout puts stream heads on this reply. That is what
      // closes the one hole in delivering in-process: an event lost between
      // COMMIT and the socket write is otherwise invisible until the next event
      // in that stream, so the last event before a silence would never arrive.
      state.send('pong');
    }
  }

  async function onHello(state: ConnectionState, hello: Hello): Promise<void> {
    if (state.claims) return;   // idempotent; a second hello changes nothing

    if (hello.protocol < MIN_PROTOCOL) {
      state.send('too_old', {
        min_protocol: MIN_PROTOCOL,
        message: 'This version can no longer sync. Please update.',
      });
      note('sync.socket.too_old', { protocol: hello.protocol });
      state.bye(CLOSE.tooOld, 'protocol too old');
      return;
    }

    let claims: SessionClaims;
    try {
      claims = await verify(hello.access_token);
    } catch {
      // A close code rather than a frame, so the client's reconnect logic can
      // tell "refresh your token and try again" from "the server went away"
      // without parsing anything.
      note('sync.socket.unauthenticated');
      state.bye(CLOSE.unauthenticated, 'bad token');
      return;
    }

    // The token proves who signed it, not that the actor still exists or is
    // still allowed in. Tokens outlive deactivation by their whole TTL, so the
    // row is what decides — and it is read here rather than trusted from the
    // claims (DESIGN §6.3).
    const actor = await deps.db.selectFrom('actors')
      .select(['id', 'handle', 'display_name', 'state'])
      .where('id', '=', claims.actorId)
      .executeTakeFirst();
    if (!actor || actor.state !== 'active') {
      note('sync.socket.unauthenticated', { reason: 'actor_inactive' });
      state.bye(CLOSE.unauthenticated, 'actor not active');
      return;
    }

    state.claims = claims;
    registry.add(state);
    state.arm(readTimeoutMs, () => {
      note('sync.socket.read_timeout');
      state.bye(CLOSE.goingAway, 'silent');
    });
    note('sync.socket.connected');

    // Only what the CONNECTION knows. Spaces, chats, memberships and cursors
    // are added to this same frame by the step that makes badges correct — as
    // added fields, because a client that predates them drops what it does not
    // know rather than failing.
    state.send('welcome', {
      protocol: PROTOCOL,
      now: Date.now(),
      actor: { id: actor.id, handle: actor.handle, display_name: actor.display_name },
    });
  }

  return {
    size: () => connections.size,
    registry,
    deliver: (event) => fanout(deps.db, registry, event),
    async close() {
      // Every connection told WHY, so clients reconnect with jitter instead of
      // discovering a dead socket at their next heartbeat. This is the half of
      // "a server restart disconnects everyone" that we control.
      for (const state of connections) state.bye(CLOSE.goingAway, 'server closing');
      connections.clear();
      await new Promise<void>(resolve => { wss.close(() => { resolve(); }); });
    },
  };
}

/**
 * One connection's state, and the single timer it owns.
 *
 * ONE timer, re-armed, rather than one per concern. The hello deadline and the
 * read deadline are the same question asked at different stages — "has this peer
 * said anything it was supposed to?" — so they share a handle, and there is no
 * way to clear one and leak the other.
 */
class ConnectionState implements Delivery {
  socket: WebSocket;
  claims: SessionClaims | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(socket: WebSocket) {
    this.socket = socket;
  }

  // ── the Delivery surface fanout sees ──
  //
  // Deliberately narrow: somewhere to put bytes, a way to tell whether that
  // somewhere is keeping up, and a way to end it. Fanout can reach none of the
  // transport state below, which is what stops it growing opinions about
  // connections.

  /** Only read after `claims` is set, which is when this joins the registry. */
  get actorId(): string { return this.claims?.actorId ?? ''; }
  get workspaceId(): string { return this.claims?.workspaceId ?? ''; }
  get backlog(): number { return this.socket.bufferedAmount; }
  drop(code: number, reason: string): void { this.bye(code, reason); }

  arm(ms: number, onExpiry: () => void): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(onExpiry, ms);
    // Otherwise an idle connection keeps the process alive through shutdown.
    this.#timer.unref?.();
  }

  send(t: string, body: Record<string, unknown> = {}): void {
    // OPEN is checked because a close can land between deciding to send and
    // sending; `ws` throws on a closed socket, and that throw would surface
    // inside whatever unrelated handler happened to be running.
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(frame(t, body));
  }

  /** Say goodbye and mean it: the timer goes even if the close never lands. */
  bye(code: number, reason: string): void {
    this.dispose();
    try { this.socket.close(code, reason); } catch { /* already gone */ }
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
