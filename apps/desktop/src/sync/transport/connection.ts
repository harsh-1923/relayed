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
import { traceparent, openSpan, type OpenSpan } from '@relayed/telemetry';
import { observe } from '../observe.ts';

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
  /**
   * Called for anything worth a marker, IN ADDITION to telemetry rather than
   * instead of it. Tests observe through this seam; production reads what
   * `observe` records from the same call, so no test runs a path production
   * does not.
   */
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
  /** When this socket went live, for the uptime a disconnect reports. */
  #liveSince = 0;
  /** The last frame of any kind. What "the server stopped answering" is measured from. */
  #lastHeard = 0;
  /**
   * The reconnect currently being attempted, as a span.
   *
   * `openSpan` rather than `startSpan` because the operation — hello, welcome,
   * catch-up complete (OBSERVABILITY.md §4) — is not a function call: it starts
   * on a socket event and ends on a frame arriving. Held here so the teardown
   * path can end one it is still carrying (invariant 54).
   */
  #connectSpan: OpenSpan | null = null;
  /** Stops listening to the gate. Called on `stop`, so a link cannot outlive it. */
  #unwatchGate: (() => void) | null = null;

  constructor(deps: ConnectionDeps) {
    this.#deps = deps;

    // THE NETWORK GOING AWAY MUST DROP A LIVE SOCKET.
    //
    // `guardConnect` refuses to OPEN one, which was the whole of "offline"
    // while the only network calls were fetches and nothing stayed connected.
    // A WebSocket that is already established never asks again — it does not
    // go through `fetch`, and nothing was closing it — so simulated offline
    // cut new connections and left the existing one syncing happily. Composing
    // "offline" went straight out over the wire and the outbox never held a
    // thing, which is exactly the path the toggle exists to exercise.
    //
    // Coming back is `retryNow` rather than waiting out a backoff: the network
    // returning is the same event as waking from sleep, and it has the same
    // answer.
    this.#unwatchGate = deps.gate.onOffline?.((offline) => {
      if (this.#state === 'stopped') return;
      if (offline) {
        // NO MARKER HERE. `#retry` drops the socket, which closes it with 1000
        // and produces `ws.disconnected` → `ws.closed{close=client_stop}` on
        // the way out; `dev.setOffline` already emits `dev.offline` for the
        // toggle itself. A third record of one event would be the duplicate
        // counting the catalogue declines elsewhere.
        //
        // Through `#retry`, not `#drop`: the socket goes AND the machine is
        // left in `backoff`, where every attempt is refused by the gate until
        // it lifts. A bare drop would leave it in `live` with no socket.
        this.#retry();
      } else {
        this.retryNow();
      }
    }) ?? null;
  }

  /**
   * Record a marker, and let a test see it too.
   *
   * One call site per event, teeing rather than choosing, so the telemetry path
   * runs in every test that asserts on the seam.
   */
  #note(name: string, detail: Record<string, unknown> = {}): void {
    observe(name, detail);
    this.#deps.onEvent?.(name, detail);
  }

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
  stop(): void {
    // Unsubscribed FIRST: a stopped link that still hears the gate would
    // resurrect itself the moment the network came back, which is the shape of
    // leak invariant 54 is about — a teardown that does not settle everything
    // it holds.
    this.#unwatchGate?.();
    this.#unwatchGate = null;
    this.#enter('stopped');
  }

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

  /**
   * Write one frame, if there is a socket to write it to.
   *
   * Silently dropped when there is not, deliberately. Every frame this sends is
   * a REQUEST for something the client can ask for again — catch-up, a
   * directory page — and each has a caller that re-asks on reconnect. Queueing
   * them would deliver a burst of stale requests the moment a socket returns,
   * against a `welcome` that has already answered most of them.
   *
   * Writes that must not be lost do not come through here: they go in the
   * outbox, which is durable and transactional with its own echo (invariant 40).
   */
  send(t: string, body: Record<string, unknown> = {}): boolean {
    if (this.#state !== 'live' || !this.#socket) return false;
    // The client's span rides the frame, so the server's handling of it becomes
    // a CHILD rather than a second trace that happens to be nearby in time.
    // A WebSocket carries no headers, which is why this is explicit and why
    // `traceparent` is a reserved envelope key (OBSERVABILITY.md §4).
    this.#socket.send(frame(t, body, traceparent()));
    return true;
  }

  // ── the machine ───────────────────────────────────────────────────────────

  /**
   * The single place a state is entered, and therefore the single place a timer
   * can leak. Everything else calls this rather than assigning `#state`.
   */
  #enter(next: LinkState): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    if (next !== 'live' && next !== 'connecting') this.#drop();
    // A connect span still open at this point never reached `welcome`, so the
    // attempt failed. Ended here rather than at each failure site because there
    // are five of them and a missed one is a span that is never reported at all
    // — the same reason every transition goes through this method.
    if (next !== 'live' && next !== 'connecting' && this.#connectSpan) {
      this.#connectSpan.end('error', next);
      this.#connectSpan = null;
    }
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

    // ONE SPAN PER ATTEMPT, and a root rather than a child: a reconnect is not
    // caused by whatever happened to be running when the timer fired, and
    // inheriting that trace would file an hour of backoff under one message.
    this.#connectSpan?.end('error', 'superseded');
    this.#connectSpan = openSpan('sync.connect', {
      root: true, attributes: { attempt: this.#attempt },
    });

    try {
      // The gate FIRST, before the constructor. Simulated offline has to refuse
      // a socket as decisively as it refuses a fetch, or half the network is
      // still up while the UI says it is not.
      guardConnect(this.#deps.gate, this.#deps.url);
      this.#socket = (this.#deps.open ?? defaultOpen)(this.#deps.url);
    } catch (e) {
      // The GATE refusing counts as a failed attempt and is recorded as one.
      // Simulated offline looks identical to a dead network here, which is the
      // point of it, so the trace has to say the same thing about both.
      this.#connectSpan?.end('error', e instanceof Error ? e.message : 'refused');
      this.#connectSpan = null;
      this.#retry();
      return;
    }

    const socket = this.#socket;
    // Every handler checks the generation. A close that arrives from a socket
    // we have already abandoned must not reset the backoff of its successor —
    // which is exactly how a reconnect loop turns into a hot loop.
    const current = (): boolean =>
      generation === this.#generation && this.#socket === socket;

    socket.on('open', (() => { if (current()) void this.#hello(current); }) as never);
    socket.on('message', ((raw: unknown, isBinary?: boolean) => {
      if (!current()) return;
      // BINARY MEANS COMPRESSED. There is no flag in the envelope saying so,
      // because a flag would have to be read out of a payload that has not been
      // decompressed yet.
      if (isBinary === true && Buffer.isBuffer(raw)) {
        try { this.#onMessage(gunzipSync(raw).toString('utf8')); }
        catch { this.#note('sync.frame.malformed', { reason: 'bad_gzip' }); }
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
      if (current()) { this.#note('ws.handshake.timeout'); this.#retry(); }
    });
  }

  /**
   * Send `hello`, once there is a token to send.
   *
   * `current` IS THE GUARD, not the state. Reading the token is asynchronous,
   * and anything can happen across that await — most obviously `retryNow`,
   * which abandons this socket and opens another. The state is `connecting`
   * again a moment later, so a state check passes and the frame is written to
   * the NEW socket, which has not opened yet: `WebSocket is not open:
   * readyState 0`, thrown out of an async function nobody awaits, which is an
   * unhandled rejection that takes the sync engine down.
   *
   * Every other handler in this class already checks the generation. This one
   * did not, and its two callers — waking from sleep, and a freshly refreshed
   * token — are exactly the moments that produce the race.
   */
  async #hello(current: () => boolean): Promise<void> {
    const token = await this.#deps.token();
    if (!current() || this.#state !== 'connecting') return;
    if (!token) {
      // No token is not a failure to connect; it is nothing to connect WITH.
      // Sitting in `unauthorised` rather than retrying means a signed-out app
      // is not opening a socket every few seconds for ever.
      this.#enter('unauthorised');
      return;
    }
    this.#connectSpan?.mark('hello');
    // Not through `send`: the state is `connecting`, and `send` deliberately
    // refuses anything before `live`. The traceparent is attached by hand for
    // the same reason — this is the ONE frame that goes out around it.
    this.#socket?.send(frame('hello', {
      protocol: PROTOCOL,
      access_token: token,
      // What this build can decompress. Advertised rather than assumed: a
      // server that does not know the word sends text, and nothing breaks.
      compression: ['gzip'],
      cursors: this.#deps.cursors?.() ?? [],
    }, traceparent(this.#connectSpan ?? undefined)));
  }

  #onMessage(raw: string): void {
    const read = readFrame(raw, OUTBOUND);
    if (read.kind === 'ignored') {
      // Invariant 43. The whole reason frames are looked up by `t` rather than
      // unioned: a server that ships a new frame type must not break a client
      // that predates it, and clients in the field are months old (RELEASE.md).
      this.#note('sync.frame.unknown', { t: read.t });
      return;
    }
    if (read.kind === 'malformed') {
      this.#note('sync.frame.malformed', { reason: read.reason });
      return;
    }

    if (read.t === 'too_old') {
      // Retrying cannot help: this build will never be new enough. Stopping is
      // the honest response, and the frame carries a message for the human.
      this.#note('sync.socket.too_old');
      this.#deps.onFrame?.(read.t, read.body);
      this.#enter('stopped');
      return;
    }

    if (read.t === 'welcome') {
      // READ BEFORE THE RESET. `ws.connected` declares an `attempt` field
      // because "how many tries did that take" is the whole question — and it
      // reported the value AFTER zeroing it, so it was always 0. The event has
      // existed since step 5 and has never once said anything.
      const attempt = this.#attempt;
      this.#attempt = 0;
      this.#liveSince = Date.now();
      this.#enter('live');
      this.#connectSpan?.annotate({ attempt });
      this.#connectSpan?.mark('welcome');
      this.#note('ws.connected', { attempt });
      // Inside the connect span, so everything `welcome` sets off — the
      // scheduler's first sweep, the directory hydration — hangs under the
      // reconnect that caused it rather than floating as its own root.
      if (this.#connectSpan) this.#connectSpan.run(() => {
        this.#deps.onWelcome?.(read.body as Welcome);
      });
      else this.#deps.onWelcome?.(read.body as Welcome);
      // Ended HERE rather than when catch-up finishes. Catch-up is scheduled
      // per stream and settles at times this layer cannot see; holding the span
      // open for it would mean holding it for a client that is a week behind.
      this.#connectSpan?.end();
      this.#connectSpan = null;
      this.#beat();
      return;
    }

    // Any frame is evidence of life, so the deadline resets on all of them
    // rather than on `pong` alone. A busy connection should not be killed for
    // failing to answer a heartbeat it never needed to send.
    this.#lastHeard = Date.now();
    if (this.#state === 'live') this.#beat();

    // `pong` is forwarded like everything else. It used to be swallowed here as
    // pure liveness, and that was right until it started carrying the stream
    // heads that bound the commit-to-socket residue — a frame with a payload
    // that never reaches its handler is a silent no-op, which is exactly the
    // shape of bug this whole layer exists to avoid.
    this.#deps.onFrame?.(read.t, read.body);
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
      // Cursors ride the heartbeat so the reply can say which streams the
      // server is ahead on. That is what bounds the commit-to-socket residue to
      // one interval: an event lost between COMMIT and the socket write has
      // nothing after it to expose it, so a quiet chat would otherwise sit one
      // message behind until somebody happened to post.
      this.#socket?.send(frame('ping', { cursors: this.#deps.cursors?.() ?? [] }));
      this.#after(this.#deps.readTimeoutMs ?? READ_TIMEOUT_MS, () => {
        // Open but dead. Indistinguishable from quiet without this deadline,
        // and the app would sit for ever believing it was synced.
        this.#note('ws.zombie.detected', {
          last_pong: this.#lastHeard === 0 ? 0 : Date.now() - this.#lastHeard,
        });
        this.#retry();
      });
    });
  }

  #onClose(code: number): void {
    this.#note('ws.disconnected', {
      code,
      // Zero when the socket never went live — a handshake that failed has no
      // uptime, and reporting the time spent connecting as uptime would make
      // a failing server look like a stable one with short sessions.
      uptime: this.#liveSince === 0 ? 0 : Date.now() - this.#liveSince,
    });
    this.#liveSince = 0;
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
