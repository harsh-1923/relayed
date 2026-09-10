// The socket, client half — step 5 of the sync build plan (docs/SYNC-FLOWS.md §2).
//
// Lives here and nowhere else: `network/no-ungated-socket` permits `new
// WebSocket` and the `ws` package only under this directory, because patching
// `globalThis.fetch` catches fetch and NOTHING ELSE. A socket opened outside
// the gate would go uncounted before first paint — an R3 violation reading as
// all-clear — and would stay connected while simulated offline claimed the
// network was cut, which is worse than not simulating it at all.
//
// Five states, three timers, one socket. What makes that tractable is that
// every transition goes through `#enter`, which clears the timer before doing
// anything else — so there is exactly one place a timer can leak, rather than
// one per exit path.
import WebSocket from 'ws';
import { gunzipSync } from 'node:zlib';
import { frame, readFrame, OUTBOUND, PROTOCOL, CLOSE, type Welcome } from '@relayed/protocol';
import { guardConnect, type Gate } from '../network.ts';

/**
 * States, and what each is waiting for.
 *
 * `unauthorised` is terminal-ish rather than terminal: the token was refused,
 * so retrying with the same one is pointless, but a refreshed token makes it
 * live again. That is what `retryNow` is for.
 *
 * `stopped` is genuinely terminal — the app is shutting down, or the protocol
 * is too old to ever succeed.
 */
export type LinkState =
  | 'idle'          // nothing running
  | 'connecting'    // socket opening, or hello sent and welcome not yet back
  | 'live'          // welcomed; heartbeat running
  | 'backoff'       // waiting to retry
  | 'unauthorised'  // token refused; waiting for a better one
  | 'stopped';      // deliberate, and final

/** Just enough of a WebSocket to run this. Injectable, so tests need no server. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  on(event: 'open' | 'close' | 'message' | 'error', handler: (...args: never[]) => void): void;
}

export interface ConnectionDeps {
  url: string;
  gate: Gate;
  /** The current access token, or null if there is not one yet. */
  token(): Promise<string | null>;
  /** Called on every state change. The renderer learns connectivity from this. */
  onState?(state: LinkState): void;
  /** The connection-level facts. Later steps hang cursors and catch-up off it. */
  onWelcome?(body: Welcome): void;
  /** Every other recognised frame. Unknown ones never reach here. */
  onFrame?(t: string, body: unknown): void;
  onEvent?(name: string, detail?: Record<string, unknown>): void;
  /**
   * How far this client has got, per stream, for `hello` to carry.
   *
   * Read at connect time rather than held, because a reconnect must send where
   * the replica is NOW — not where it was when the connection object was built,
   * which after a long backoff is a different place entirely.
   */
  cursors?(): { kind: string; id: string; rev: number }[];
  /** Seams. Tests supply a fake socket and a fixed jitter; nothing else does. */
  open?(url: string): SocketLike;
  random?(): number;
  heartbeatMs?: number;
  readTimeoutMs?: number;
  helloTimeoutMs?: number;
}

/**
 * Under 30 seconds is a floor, not a tuning knob: intermediaries close idle
 * sockets at 60s (ALB, nginx) and Cloudflare at 100s (DESIGN §13.9). A quiet
 * connection has to make noise before the shortest of them loses patience.
 */
const HEARTBEAT_MS = 25_000;

/** Two missed heartbeats. One dropped ping is survivable; two is a dead peer. */
const READ_TIMEOUT_MS = 60_000;

/** How long the handshake may hang before it counts as a failed attempt. */
const HELLO_TIMEOUT_MS = 10_000;

const BACKOFF_CAP_MS = 30_000;

/**
 * How long to wait before attempt N, with FULL jitter.
 *
 * A pure function rather than four lines inside the retry path, because the
 * curve is the part worth reviewing and the only way to check a buried version
 * is to drive eight real reconnects and time them — which is slow, flaky, and
 * therefore a test nobody keeps.
 *
 * Full jitter means a uniform draw from `[0, ceiling]`, NOT the ceiling with a
 * wobble added. The difference is the whole point: after a server restart every
 * client has failed the same number of times, so a curve without the draw has
 * ten thousand of them returning in the same instant — a `welcome` burst and a
 * catch-up burst arriving together (invariant 31). Spread across the window it
 * is unremarkable.
 *
 * The cap matters for the opposite reason. Doubling without one reaches hours,
 * and a client that sleeps for hours after a blip is indistinguishable from one
 * that is broken.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(1_000 * 2 ** attempt, BACKOFF_CAP_MS);
  return random() * ceiling;
}

export class Connection {
  #deps: ConnectionDeps;
  #state: LinkState = 'idle';
  #socket: SocketLike | null = null;
  #timer: NodeJS.Timeout | null = null;
  #attempt = 0;
  /** Guards against a stale socket's events being applied after a transition. */
  #generation = 0;

  constructor(deps: ConnectionDeps) { this.#deps = deps; }

  get state(): LinkState { return this.#state; }
  get attempt(): number { return this.#attempt; }

  /** Begin, or do nothing if already going. Idempotent by design. */
  start(): void {
    if (this.#state === 'idle' || this.#state === 'stopped') this.#connect();
  }

  /**
   * Stop for good, and settle everything.
   *
   * A teardown must settle every promise it abandons (invariant 54). Both
   * Phase 1 bugs in this area were cleanup that did not run on an exit path,
   * which is why teardown is one call rather than a sequence a caller composes.
   */
  stop(): void { this.#enter('stopped'); }

  /**
   * Reconnect NOW, without waiting out a backoff.
   *
   * Two callers: waking from sleep, and a freshly refreshed token. Waking is
   * the interesting one — after a laptop sleeps, TCP does not know the
   * connection is dead and will not find out for minutes, so the machine's own
   * `resume` is the only prompt signal there is (invariant 30).
   */
  retryNow(): void {
    if (this.#state === 'stopped' || this.#state === 'live') return;
    this.#attempt = 0;
    this.#connect();
  }

  // ── the machine ───────────────────────────────────────────────────────────

  /**
   * The single place a state is entered, and therefore the single place a timer
   * can leak. Everything else calls this rather than assigning `#state`.
   */
  #enter(next: LinkState): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    if (next !== 'live' && next !== 'connecting') this.#drop();
    this.#state = next;
    this.#deps.onState?.(next);
  }

  #after(ms: number, run: () => void): void {
    this.#timer = setTimeout(run, ms);
    this.#timer.unref?.();
  }

  /** Abandon the socket without waiting for a close handshake that may never come. */
  #drop(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#generation++;
    if (!socket) return;
    try { socket.close(1000, 'client'); } catch { /* already gone */ }
  }

  #connect(): void {
    this.#enter('connecting');
    this.#generation++;
    const generation = this.#generation;

    try {
      // The gate FIRST, before the constructor. Simulated offline has to refuse
      // a socket as decisively as it refuses a fetch, or half the network is
      // still up while the UI says it is not.
      guardConnect(this.#deps.gate, this.#deps.url);
      this.#socket = (this.#deps.open ?? defaultOpen)(this.#deps.url);
    } catch {
      this.#retry();
      return;
    }

    const socket = this.#socket;
    // Every handler checks the generation. A close that arrives from a socket
    // we have already abandoned must not reset the backoff of its successor —
    // which is exactly how a reconnect loop turns into a hot loop.
    const current = (): boolean =>
      generation === this.#generation && this.#socket === socket;

    socket.on('open', (() => { if (current()) void this.#hello(); }) as never);
    socket.on('message', ((raw: unknown, isBinary?: boolean) => {
      if (!current()) return;
      // BINARY MEANS COMPRESSED. There is no flag in the envelope saying so,
      // because a flag would have to be read out of a payload that has not been
      // decompressed yet.
      if (isBinary === true && Buffer.isBuffer(raw)) {
        try { this.#onMessage(gunzipSync(raw).toString('utf8')); }
        catch { this.#deps.onEvent?.('sync.frame.malformed', { reason: 'bad_gzip' }); }
        return;
      }
      this.#onMessage(String(raw));
    }) as never);
    socket.on('close', ((code: number) => {
      if (current()) this.#onClose(Number(code));
    }) as never);
    // `ws` emits 'error' and then 'close'; without a listener it throws on the
    // process instead. Handled and ignored — the close is what we act on.
    socket.on('error', (() => {}) as never);

    this.#after(this.#deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS, () => {
      if (current()) { this.#deps.onEvent?.('ws.handshake.timeout'); this.#retry(); }
    });
  }

  async #hello(): Promise<void> {
    const token = await this.#deps.token();
    if (this.#state !== 'connecting') return;
    if (!token) {
      // No token is not a failure to connect; it is nothing to connect WITH.
      // Sitting in `unauthorised` rather than retrying means a signed-out app
      // is not opening a socket every few seconds for ever.
      this.#enter('unauthorised');
      return;
    }
    this.#socket?.send(frame('hello', {
      protocol: PROTOCOL,
      access_token: token,
      // What this build can decompress. Advertised rather than assumed: a
      // server that does not know the word sends text, and nothing breaks.
      compression: ['gzip'],
      cursors: this.#deps.cursors?.() ?? [],
    }));
  }

  #onMessage(raw: string): void {
    const read = readFrame(raw, OUTBOUND);
    if (read.kind === 'ignored') {
      // Invariant 43. The whole reason frames are looked up by `t` rather than
      // unioned: a server that ships a new frame type must not break a client
      // that predates it, and clients in the field are months old (RELEASE.md).
      this.#deps.onEvent?.('sync.frame.unknown', { t: read.t });
      return;
    }
    if (read.kind === 'malformed') {
      this.#deps.onEvent?.('sync.frame.malformed', { reason: read.reason });
      return;
    }

    if (read.t === 'too_old') {
      // Retrying cannot help: this build will never be new enough. Stopping is
      // the honest response, and the frame carries a message for the human.
      this.#deps.onEvent?.('sync.socket.too_old');
      this.#deps.onFrame?.(read.t, read.body);
      this.#enter('stopped');
      return;
    }

    if (read.t === 'welcome') {
      this.#attempt = 0;
      this.#enter('live');
      this.#deps.onEvent?.('ws.connected', { attempt: this.#attempt });
      this.#deps.onWelcome?.(read.body as Welcome);
      this.#beat();
      return;
    }

    // Any frame is evidence of life, so the deadline resets on all of them
    // rather than on `pong` alone. A busy connection should not be killed for
    // failing to answer a heartbeat it never needed to send.
    if (this.#state === 'live') this.#beat();
    if (read.t !== 'pong') this.#deps.onFrame?.(read.t, read.body);
  }

  /**
   * Send a ping and arm the read deadline.
   *
   * The heartbeat is CLIENT-initiated, which is one mechanism serving both
   * directions: we learn the server is alive from the pong, and the server
   * learns we are alive from the ping. Two independent heartbeats would be
   * twice the traffic to answer the same question.
   */
  #beat(): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    this.#after(this.#deps.heartbeatMs ?? HEARTBEAT_MS, () => {
      if (this.#state !== 'live') return;
      this.#socket?.send(frame('ping'));
      this.#after(this.#deps.readTimeoutMs ?? READ_TIMEOUT_MS, () => {
        // Open but dead. Indistinguishable from quiet without this deadline,
        // and the app would sit for ever believing it was synced.
        this.#deps.onEvent?.('ws.zombie.detected', {});
        this.#retry();
      });
    });
  }

  #onClose(code: number): void {
    this.#deps.onEvent?.('ws.disconnected', { code });
    if (code === CLOSE.tooOld) { this.#enter('stopped'); return; }
    if (code === CLOSE.unauthenticated) {
      // Reconnecting with the same rejected token would be a tight loop against
      // a server that has already said no. Something with a better token calls
      // `retryNow`; until then this state is where we wait.
      this.#enter('unauthorised');
      return;
    }
    this.#retry();
  }

  /**
   * Back off with FULL jitter, and the jitter is load-bearing rather than
   * polite: ten thousand clients reconnecting together is a `welcome` burst and
   * a catch-up burst landing in one instant. Spread over the window it is
   * unremarkable (invariant 31).
   *
   * Full jitter — a uniform draw from [0, cap] — not "cap plus a wobble". The
   * latter still has every client arriving in the same narrow band.
   */
  #retry(): void {
    if (this.#state === 'stopped') return;
    this.#enter('backoff');
    const delay = backoffDelay(this.#attempt, this.#deps.random ?? Math.random);
    this.#attempt++;
    this.#after(delay, () => { this.#connect(); });
  }
}

function defaultOpen(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}
