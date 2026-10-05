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
import { versionAnswer } from '../web/version.ts';
import type { Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Kysely } from 'kysely';
import {
  readFrame, frame, INBOUND, PROTOCOL, MIN_PROTOCOL, CLOSE,
  type Hello, type CatchupRequest, type BackfillRequest, type RepairRequest,
  type ThreadRequest, type DirectoryRequest, type AgentDefinitionRequest, type RosterRequest,
  type OpFrame, type Ping, type ActivityRequest,
} from '@relayed/protocol';
import { can, chat as chatTarget, space as spaceTarget } from '@relayed/authz';
import { loadGrants } from '../authz/can.ts';
import { chatPlacement, spacePlacement } from './placement.ts';
import type { DB } from '../db/schema.ts';
import { verifyAccessToken, type SessionClaims } from '../auth/tokens.ts';
import { Registry, type Delivery } from './registry.ts';
import { fanout, type FanoutResult } from './fanout.ts';
import { parseStream, type AppendedEvent, type Stream } from './events.ts';
import {
  welcome, catchup, backfill, repair, threadReplies, streamHead, directoryPage, rosterPage,
  type Snapshot, type MessageRow,
} from './feed.ts';
import { send, deleteMessage, MessageNotFoundError, PartsRefusedError } from './ops.ts';
import { agentDefinition } from '../agents/definitions.ts';
import {
  publishActivity, endActivityWhere, chatAudience, cachedAudience,
} from './activity.ts';
import { Forbidden } from '../authz/can.ts';
import {
  startSpan, openSpan, annotate, traceparent, parseTraceparent,
} from '@relayed/telemetry';
import {
  observe, recordOp, recordCatchupDuration, recordWelcome,
} from './observe.ts';

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

/**
 * Frames above this are compressed, when the client said it could.
 *
 * ONE-SHOT, PER FRAME — which is why this does not reopen the decision to leave
 * `permessage-deflate` off (invariant 28). That rule exists because PERSISTENT
 * compression holds a zlib context for the life of every connection: ~189 KB
 * each, seventeen times the connection itself, 1.8 GB at ten thousand of them.
 * Compressing one frame allocates, compresses and frees. Different mechanism,
 * opposite conclusion.
 *
 * Eight kilobytes because below it the saving is smaller than the syscall.
 * `welcome` at any real workspace size is far above; a single `ev` frame is far
 * below and stays text.
 */
const COMPRESS_ABOVE_BYTES = 8_192;

/**
 * How many cursors one heartbeat may ask about.
 *
 * A cap rather than a limit anybody will reach: a person in 150 chats sends 150,
 * and this stops a modified client turning a twenty-five-second heartbeat into
 * an unbounded read.
 */
const PING_CURSOR_LIMIT = 500;

export interface SocketDeps {
  db: Kysely<DB>;
  /** Injected so a test does not need a signing key, and nothing else does. */
  verify?: (token: string) => Promise<SessionClaims>;
  helloTimeoutMs?: number;
  readTimeoutMs?: number;
  /**
   * Called for anything worth a marker, IN ADDITION to telemetry rather than
   * instead of it. Tests observe through this seam; production reads the
   * metrics `observe` records from the same call. Wiring them as alternatives
   * would mean every test ran a code path production does not.
   */
  onEvent?: (name: string, detail?: Record<string, unknown>) => void;
  /** Nudged after a send admits a run, so it need not wait for the next poll (WORKSPACE-AGENTS.md §5.3). */
  dispatcher?: { wake(): void };
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
  const note = (name: string, detail: Record<string, unknown> = {}): void => {
    observe(name, detail);
    deps.onEvent?.(name, detail);
  };

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
  // Typing asks for a chat's audience every few seconds per typist (ACTIVITY.md §5.3).
  const typingAudience = cachedAudience(chatAudience(deps.db), 5_000);

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
      state.bye(CLOSE.helloTimeout, 'no hello', 'hello_timeout');
    });

    const forget = (): void => {
      // `ws` emits `error` and then `close`, so this runs twice for one
      // departure. Counted once, or every errored socket is two disconnects.
      if (state.disposed) return;
      const wasAuthenticated = state.claims !== null;
      state.dispose();
      connections.delete(state);
      // Removed on BOTH paths. A registry that only shed connections on a clean
      // close would keep writing to sockets that errored — and that leak's
      // symptom is memory on the busiest server, months later.
      if (state.claims) registry.remove(state);
      // Whatever this connection was typing ends with it, rather than lingering
      // for its TTL on everyone else's screen (ACTIVITY.md §5.2).
      if (state.claims) {
        // After any activity frame still in flight, or it would land after this.
        void state.activity
          .then(() => endActivityWhere(registry, typingAudience, 'typing', typingKeyPrefix(state)))
          .catch((e: unknown) => { failure(e); });
      }
      // AFTER the removal, so the gauge is the count that remains rather than
      // the one that included this socket.
      if (wasAuthenticated) {
        note('sync.socket.gone', {
          close: state.closeReason, sessions: registry.size(),
          uptime: Date.now() - state.openedAt,
        });
      }
    };
    socket.on('message', (raw: Buffer) => {
      // THE ERROR BOUNDARY, and on the server it is the difference between one
      // refused frame and an outage. `onMessage` is async and nothing awaits
      // it, so a handler that throws — a database blip inside `welcome`, a
      // driver error mid-catch-up — becomes an unhandled rejection and takes
      // the process down, disconnecting every client on it.
      //
      // The connection SURVIVES. One frame failing is not evidence the peer is
      // broken, and closing would turn a transient fault into a reconnect
      // storm at exactly the moment the database is already struggling
      // (invariant 31). The client asks again; the ops are idempotent.
      void onMessage(state, raw).catch((e: unknown) => { failure(e); });
    });
    socket.on('error', () => {
      // A transport-level failure, which is genuinely different from the peer
      // choosing to leave. `ws` emits this and then `close`; the first one
      // through sets the reason and `forget` counts it once.
      state.closeReason = 'error';
      forget();
    });
    socket.on('close', forget);
  }

  /**
   * Report one caught failure.
   *
   * The MESSAGE goes on a span and nowhere else. Every event field type is
   * structured by construction — there is no free text an error string could
   * occupy (§6) — and a span records `e.message` alone, never the thrown value,
   * which can carry anything a caller attached to it. A span here rather than
   * relying on the handler's own is deliberate: `ping` is not traced, and a
   * frame that fails before dispatch has no span of its own at all.
   */
  function failure(e: unknown): void {
    const span = openSpan('sync.failed', { attributes: { stage: 'frame' } });
    span.end('error', e instanceof Error ? e.message : 'error');
    note('sync.failed', { stage: 'frame' });
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

    // The client's span, if it sent one. Everything below becomes a CHILD of
    // it, which is what makes "user pressed send" and "server assigned the
    // ordinal" one trace rather than two that happen to be adjacent in time.
    const parent = parseTraceparent(read.traceparent);

    if (read.t === 'hello') {
      await startSpan('sync.hello', () => onHello(state, read.body as Hello),
                      { parent });
      return;
    }

    // Everything past here needs an authenticated connection. Silence rather
    // than an error frame: a peer that has not said hello is a peer we know
    // nothing about, and the deadline is already dealing with it.
    if (!state.claims) return;
    state.arm(readTimeoutMs, () => {
      note('sync.socket.read_timeout');
      state.bye(CLOSE.goingAway, 'silent', 'read_timeout');
    });

    if (read.t === 'catchup') {
      await startSpan('sync.catchup', () => onCatchup(state, read.body as CatchupRequest),
                      { parent });
      return;
    }
    if (read.t === 'backfill') {
      await startSpan('sync.backfill', () => onBackfill(state, read.body as BackfillRequest),
                      { parent });
      return;
    }
    if (read.t === 'repair') {
      await startSpan('sync.repair', () => onRepair(state, read.body as RepairRequest),
                      { parent });
      return;
    }
    if (read.t === 'thread') {
      await startSpan('sync.thread', () => onThread(state, read.body as ThreadRequest),
                      { parent });
      return;
    }
    if (read.t === 'directory') {
      await startSpan('sync.directory', () => onDirectory(state, read.body as DirectoryRequest),
                      { parent });
      return;
    }
    if (read.t === 'roster') {
      await startSpan('sync.roster', () => onRoster(state, read.body as RosterRequest),
                      { parent });
      return;
    }
    if (read.t === 'op') {
      await startSpan('sync.op', () => onOp(state, read.body as OpFrame), { parent });
      return;
    }
    if (read.t === 'agent_definition') {
      await startSpan('sync.agent_definition',
        () => onAgentDefinition(state, read.body as AgentDefinitionRequest), { parent });
      return;
    }

    // Not traced either, for `ping`'s reason: one frame per typist every few
    // seconds is volume, not a logical operation anybody asks about.
    // IN ORDER per connection. Frames are otherwise handled concurrently, and
    // an `ended` needs no authorisation, so it would overtake the `active` sent
    // just before it and leave the typist showing for a whole TTL after Enter.
    if (read.t === 'activity') {
      const request = read.body as ActivityRequest;
      state.activity = state.activity.then(() => onActivity(state, request));
      await state.activity;
      return;
    }

    // `ping` is NOT traced. A span is a logical operation, never a connection
    // (OBSERVABILITY.md §4) — one span per heartbeat per socket every
    // twenty-five seconds is the largest trace volume in the system and it
    // answers no question at all.
    if (read.t === 'ping') {
      // The heartbeat is CLIENT-initiated, which is one mechanism serving both
      // directions: the client learns the server is alive from this reply, and
      // the server learns the client is alive from the ping that caused it.
      await onPing(state, read.body as Ping);
    }
  }

  /**
   * May this actor read this stream?
   *
   * NEVER INFERRED FROM THE CURSOR. A client sends the stream id it wants, and a
   * modified one can send any id at all — so the answer comes from `can()` over
   * grants loaded now, exactly as it would for any other read. The cursor says
   * how far along, not whether.
   *
   * A workspace stream is readable by anyone in the workspace, which the token
   * already establishes: the connection's own workspace claim IS the check, and
   * comparing it here is the whole of it.
   */
  async function mayRead(claims: SessionClaims, stream: Stream): Promise<boolean> {
    if (stream.kind === 'workspace') return stream.id === claims.workspaceId;

    const [grants, placement] = await Promise.all([
      loadGrants(deps.db, claims.actorId),
      stream.kind === 'chat'
        ? chatPlacement(deps.db, stream.id)
        : spacePlacement(deps.db, stream.id),
    ]);
    const target = stream.kind === 'chat' ? chatTarget(stream.id) : spaceTarget(stream.id);
    return can(grants, 'read', target, placement);
  }

  async function onCatchup(state: ConnectionState, request: CatchupRequest): Promise<void> {
    const claims = state.claims;
    if (!claims) return;

    // Narrowed, never cast. A `kind` this server does not have is ignored the
    // same way an unknown frame is — a newer client naming a stream kind this
    // deployment predates must not be an error.
    const stream = parseStream(request.stream);
    if (!stream) { note('sync.frame.unknown', { t: `catchup:${request.stream.kind}` }); return; }

    // SILENCE rather than a denial frame. Telling an actor that a stream exists
    // but is not theirs is a disclosure; telling them nothing is not. The client
    // is asking about something it was told about, so in practice this only
    // fires for a modified one.
    if (!await mayRead(claims, stream)) {
      note('sync.catchup.denied', { kind: stream.kind });
      return;
    }

    // Ids on a SPAN, never on a metric label — this is the split §5 exists for,
    // and it is what makes "why did this person's reconnect hang" answerable at
    // all while the metric stays three series.
    annotate({ stream_kind: stream.kind, stream_id: stream.id,
               from_rev: request.from_rev });

    const started = performance.now();
    // As THIS actor: a replay redacts, and a tail filters, what they may not see.
    const result = await catchup(deps.db, claims.actorId, stream, request.from_rev);
    if (result.kind === 'gap') {
      recordCatchupDuration('gap', performance.now() - started);
      annotate({ answer: 'gap', head_rev: result.headRev });
      note('sync.gap.sent', { kind: request.stream.kind });
      state.send('gap', {
        stream, head_rev: result.headRev, snapshot: onWire(result.snapshot),
      });
      return;
    }

    const complete = result.toRev >= await streamHead(deps.db, stream);
    recordCatchupDuration('replay', performance.now() - started);
    annotate({ answer: 'replay', to_rev: result.toRev, complete });
    note('sync.catchup.sent', { events: result.events.length });
    state.send('catchup_ok', {
      stream,
      from_rev: result.fromRev,
      to_rev: result.toRev,
      // False when the batch was capped by the read limit and another round is
      // owed. The client must not stop asking just because a reply arrived.
      complete,
      events: result.events,
    });
  }

  async function onBackfill(state: ConnectionState, request: BackfillRequest): Promise<void> {
    const claims = state.claims;
    if (!claims) return;
    if (!await mayRead(claims, { kind: 'chat', id: request.c })) {
      note('sync.backfill.denied');
      return;
    }

    const limit = request.limit ?? 50;
    const rows = await backfill(deps.db, claims.actorId, request.c, request.before_ord, limit);
    state.send('backfill_ok', {
      c: request.c,
      rows: rows.map(rowOnWire),
      // A short page means the beginning was reached. Derived rather than asked
      // for, so a client cannot be told to keep paging into nothing — and
      // correct ONLY because `backfill` hides what this reader may not see in
      // its query, before the limit. Hidden afterwards, one restricted row on a page
      // would make it short, this would say `complete`, and the client would
      // stop asking with history still below it (invariant 79).
      complete: rows.length < limit,
    });
  }

  /**
   * What changed, among the messages a client already holds, while it was past
   * the gap threshold — the other half of taking a gap (SYNC-FLOWS.md, the
   * repair flow). Gated exactly as backfill is: the client names a chat, and
   * the answer depends on whether it may read that chat, never on the cursor
   * it sent.
   */
  async function onRepair(state: ConnectionState, request: RepairRequest): Promise<void> {
    const claims = state.claims;
    if (!claims) return;
    if (!await mayRead(claims, { kind: 'chat', id: request.c })) {
      note('sync.repair.denied');
      return;
    }
    const limit = request.limit ?? 50;
    const rows = await repair(deps.db, claims.actorId, request.c, request.since_rev,
                              request.max_ord, request.after ?? null, limit);
    const last = rows.at(-1);
    state.send('repair_ok', {
      c: request.c,
      rows: rows.map(rowOnWire),
      complete: rows.length < limit,
      // Where the next page starts. The LAST ROW's (rev, id), never the head:
      // a row that changes again after this page moves past this cursor and
      // is served again, complete, which is what makes a repair converge under
      // live traffic rather than merely finish.
      after: last ? { rev: last.rev, id: last.id } : request.after ?? null,
    });
  }

  /** One page of a thread (DESIGN.md §8.2). Read-gated on the chat, like everything else. */
  async function onThread(state: ConnectionState, request: ThreadRequest): Promise<void> {
    const claims = state.claims;
    if (!claims) return;
    if (!await mayRead(claims, { kind: 'chat', id: request.c })) {
      note('sync.thread.denied');
      return;
    }
    const limit = request.limit ?? 50;
    const rows = await threadReplies(deps.db, claims.actorId, request.c, request.root,
                                     request.after_ord, limit);
    state.send('thread_ok', {
      c: request.c,
      root: request.root,
      rows: rows.map(rowOnWire),
      complete: rows.length < limit,
    });
  }

  /**
   * One page of the directory.
   *
   * Scoped by the TOKEN's workspace, never by a parameter — a workspace id in a
   * request is not evidence of membership in it. That is the whole of the
   * authorization here, and it is enough: every member of a workspace is
   * entitled to all of its directory, which is precisely why the directory can
   * be a workspace-wide stream at all (DESIGN.md §9.9).
   *
   * `head_rev` rides along so the client knows what cursor this snapshot
   * corresponds to. Read BEFORE the page rather than after: taken afterwards it
   * could be higher than the data, and the client would jump its frontier past
   * a change the page did not contain.
   */
  async function onDirectory(
    state: ConnectionState, request: DirectoryRequest,
  ): Promise<void> {
    const claims = state.claims;
    if (!claims) return;

    const headRev = await streamHead(deps.db, {
      kind: 'workspace', id: claims.workspaceId,
    });
    const page = await directoryPage(
      deps.db, claims.workspaceId, request.after_id ?? null, request.limit,
    );

    note('sync.directory.page', { rows: page.rows.length });
    state.send('directory_ok', {
      rows: page.rows.map(row => ({
        id: row.id, type: row.type, handle: row.handle,
        display_name: row.displayName, avatar_url: row.avatarUrl,
        owner_actor_id: row.ownerActorId, state: row.state,
        updated_at: row.updatedAt,
        ...(row.agent ? { agent: row.agent } : {}),
      })),
      next_after_id: page.nextAfterId,
      complete: page.complete,
      head_rev: headRev,
    });
  }

  /**
   * One page of who is in some spaces. Answered as the connection's actor, and
   * only for spaces that actor is in; `space_ids` says which those were.
   */
  async function onRoster(state: ConnectionState, request: RosterRequest): Promise<void> {
    const claims = state.claims;
    if (!claims) return;
    const page = await rosterPage(
      deps.db, claims.actorId, request.space_ids,
      request.after ? { spaceId: request.after.space_id, actorId: request.after.actor_id } : null,
      request.limit,
    );
    note('sync.roster.page', { rows: page.rows.length });
    state.send('roster_ok', {
      space_ids: page.spaceIds,
      rows: page.rows.map(row => ({
        space_id: row.spaceId, actor_id: row.actorId, role: row.role, joined_at: row.joinedAt,
      })),
      next_after: page.nextAfter ? { space_id: page.nextAfter.spaceId, actor_id: page.nextAfter.actorId } : null,
      complete: page.complete,
    });
  }

  /**
   * What an agent was told (WORKSPACE-AGENTS.md §4.5), for anyone in its
   * workspace. Answered as the connection's actor — never a workspace or an
   * actor named in the request — and with `found: false` rather than silence
   * when they may not read it, because a person is waiting on the answer.
   */
  async function onAgentDefinition(
    state: ConnectionState, request: AgentDefinitionRequest,
  ): Promise<void> {
    const claims = state.claims;
    if (!claims) return;
    annotate({ agent_id: request.agent_id });
    const d = await agentDefinition(deps.db, claims.actorId, request.agent_id);
    state.send('agent_definition_ok', d === null
      ? { agent_id: request.agent_id, found: false }
      : {
          agent_id: request.agent_id, found: true,
          definition: {
            description: d.description, instructions: d.instructions, model: d.model,
            thinking_level: d.thinkingLevel, config_rev: d.configRev, created_by: d.createdBy,
            created_at: d.createdAt, updated_at: d.updatedAt, maintainers: d.maintainers,
            // Always empty since agents find their own tools (the plan's step 7);
            // still sent because clients built before it require the field.
            tools: [], space_ids: d.spaceIds,
            you: { edit: d.you.edit, manage_maintainers: d.you.manageMaintainers,
                   deactivate: d.you.deactivate },
          },
        });
  }

  /**
   * A write, and the only frame that changes anything.
   *
   * The ack goes to the SENDER and the event goes to the audience — including
   * the sender, whose other devices need it and whose own client applies it
   * down the same path as every other. One convergence mechanism rather than a
   * special case for "mine".
   *
   * FANNED OUT AFTER THE TRANSACTION COMMITS, never inside: a rollback would
   * otherwise have already told every client about something that never
   * happened, and nothing afterwards looks wrong.
   */
  /**
   * Someone typing (ACTIVITY.md §5.2). Dropped silently and counted, never
   * answered: the sender has nothing to do with a refusal, and telling them a
   * chat or thread exists is a disclosure.
   */
  async function onActivity(state: ConnectionState, request: ActivityRequest): Promise<void> {
    // Caught here rather than by the frame boundary: the chain in `onMessage`
    // must never hold a rejection, or every later frame would rethrow it.
    try { await acceptActivity(state, request); } catch (e: unknown) { failure(e); }
  }

  async function acceptActivity(state: ConnectionState, request: ActivityRequest): Promise<void> {
    const claims = state.claims;
    if (!claims) return;
    // Only typing may come from a client; a run is the dispatcher's.
    if (request.kind !== 'typing') { note('sync.frame.unknown', { t: `activity:${request.kind}` }); return; }

    // Ending needs no check: it can only end this connection's own entry,
    // and ending one that does not exist sends nothing.
    if (request.state === 'active') {
      const [grants, placement] = await Promise.all([
        loadGrants(deps.db, claims.actorId), chatPlacement(deps.db, request.chat_id),
      ]);
      if (!can(grants, 'post', chatTarget(request.chat_id), placement)) {
        note('sync.activity.dropped', { reason: 'unauthorised' });
        return;
      }
      if (request.thread_id !== null) {
        // A thread root in this chat that anybody who reads the chat can see —
        // nothing replies to a restricted message (§8.8), so nobody types there.
        const root = await deps.db.selectFrom('messages').select('id')
          .where('id', '=', request.thread_id).where('chat_id', '=', request.chat_id)
          .where('parent_id', 'is', null).where('visible_to', 'is', null)
          .executeTakeFirst();
        if (!root) { note('sync.activity.dropped', { reason: 'no_thread' }); return; }
      }
    }

    await publishActivity(registry, typingAudience, {
      kind: 'typing', key: `${typingKeyPrefix(state)}${request.chat_id}:${request.thread_id ?? ''}`,
      chatId: request.chat_id, threadId: request.thread_id,
      actorId: claims.actorId, workspaceId: claims.workspaceId, state: request.state,
    });
  }

  async function onOp(state: ConnectionState, frame: OpFrame): Promise<void> {
    const claims = state.claims;
    if (!claims) return;

    annotate({ op_id: frame.op_id, op_kind: frame.kind, chat_id: frame.c,
               actor_id: claims.actorId });
    const started = performance.now();
    try {
      const applied = frame.kind === 'send'
        ? await send(deps.db, {
            opId: frame.op_id, chatId: frame.c, actorId: claims.actorId,
            messageId: frame.target, body: frame.m?.body ?? '',
            parentId: frame.m?.parent_id ?? null,
            ...(frame.m?.parts !== undefined ? { parts: frame.m.parts } : {}),
          })
        : await deleteMessage(deps.db, {
            opId: frame.op_id, chatId: frame.c, actorId: claims.actorId,
            messageId: frame.target,
          });

      state.send('ack', {
        op_id: frame.op_id,
        id: applied.ack.messageId, c: applied.ack.chatId,
        ord: applied.ack.ord, rev: applied.ack.rev,
        created_at: applied.ack.createdAt,
      });

      recordOp(frame.kind, true, performance.now() - started);
      // A REPLAY is worth saying out loud in the trace rather than inferring
      // from an absent fanout: it is the idempotency ledger working, and it
      // looks identical to a delivery failure from the outside.
      annotate({ ord: applied.ack.ord ?? undefined, rev: applied.ack.rev,
                 replayed: applied.event === undefined });

      // Absent on a REPLAY, which is the whole reason the ops report it: the
      // retried op returned the stored ack without doing the work, so fanning
      // out here would deliver a duplicate to every other device while the
      // sender's own ack correctly reported one.
      if (applied.event) await fanout(deps.db, registry, applied.event);
      // Latency only: the dispatcher's own poll would find this run anyway.
      if (applied.runIds.length > 0) deps.dispatcher?.wake();
    } catch (err) {
      recordOp(frame.kind, false, performance.now() - started);
      const nack = nackFor(frame.op_id, err);
      annotate({ nack_code: String(nack['code']), retryable: nack['retryable'] === true });
      state.send('nack', nack);
    }
  }

  /**
   * Answer the heartbeat, and say which streams the client is behind on.
   *
   * THE RESIDUE THIS CLOSES. Fanout runs in-process after the transaction
   * commits, so a server that dies between `COMMIT` and the socket write leaves
   * an event durable and undelivered. It mostly self-repairs — the next event
   * in that stream lands above the client's frontier and triggers catch-up —
   * but the LAST event before a silence has nothing after it to expose it. A
   * quiet channel would sit one message behind until somebody happened to post.
   *
   * Comparing heads here bounds that to one heartbeat interval. Bounded to what
   * the client actually asked about, and only the streams where the server is
   * ahead come back — a caught-up client gets an empty reply, which matters at
   * one of these per connection every twenty-five seconds.
   */
  async function onPing(state: ConnectionState, ping: Ping): Promise<void> {
    const cursors = ping.cursors ?? [];
    if (cursors.length === 0) { state.send('pong'); return; }

    const behind: { kind: string; id: string; rev: number }[] = [];
    // Capped, so a client cannot turn its heartbeat into an unbounded read by
    // naming every stream it has ever heard of.
    for (const cursor of cursors.slice(0, PING_CURSOR_LIMIT)) {
      const stream = parseStream(cursor);
      if (!stream) continue;
      const head = await streamHead(deps.db, stream);
      if (head > cursor.rev) behind.push({ kind: stream.kind, id: stream.id, rev: head });
    }

    // No authorization check, and none is needed: a head revision is a COUNT of
    // changes, not their content, and the client already holds a cursor for
    // every stream it names. Telling somebody a number they could reach by
    // asking for catch-up — which IS gated — discloses nothing new.
    state.send('pong', behind.length > 0 ? { behind } : {});
  }

  async function onHello(state: ConnectionState, hello: Hello): Promise<void> {
    if (state.claims) return;   // idempotent; a second hello changes nothing

    if (hello.protocol < MIN_PROTOCOL) {
      state.send('too_old', {
        min_protocol: MIN_PROTOCOL,
        message: 'This version can no longer sync. Please update.',
      });
      note('sync.socket.too_old', { protocol: hello.protocol });
      state.bye(CLOSE.tooOld, 'protocol too old', 'too_old');
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
      state.bye(CLOSE.unauthenticated, 'bad token', 'unauthenticated');
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
      state.bye(CLOSE.unauthenticated, 'actor not active', 'unauthenticated');
      return;
    }

    state.claims = claims;
    // Only what this build can actually decompress, intersected with what we
    // can produce. An algorithm we do not know is ignored rather than refused,
    // so a newer client offering something better costs nothing today.
    state.compress = hello.compression?.includes('gzip') === true;
    registry.add(state);
    state.arm(readTimeoutMs, () => {
      note('sync.socket.read_timeout');
      state.bye(CLOSE.goingAway, 'silent', 'read_timeout');
    });
    note('sync.socket.connected', { sessions: registry.size() });
    annotate({ actor_id: actor.id, workspace_id: claims.workspaceId,
               protocol: hello.protocol, compress: state.compress });

    // THE FRAME THAT SATISFIES R2. After this one exchange every badge in the
    // sidebar is correct and not one message body has been fetched — because
    // "I have it" and "I know it exists" are different facts, and `welcome`
    // carries the second for every chat the actor can reach.
    const payload = await welcome(deps.db, claims.workspaceId, claims.actorId);

    const bytes = state.send('welcome', {
      protocol: PROTOCOL,
      now: Date.now(),
      // Which build we expect, on every connection (RELEASE.md §1). The socket
      // reconnects on deploys, network changes and waking from sleep, so a
      // floor raised after a bad build reaches people in seconds rather than
      // within the hour a poll window allows. `GET /version` still answers the
      // clients a socket cannot: too old, or not signed in.
      version: versionAnswer(),
      actor: { id: actor.id, handle: actor.handle, display_name: actor.display_name },
      spaces: payload.spaces.map(space => ({
        id: space.id, kind: space.kind, name: space.name, slug: space.slug,
        visibility: space.visibility, membership_policy: space.membershipPolicy,
        lifecycle: space.lifecycle, created_by_actor_id: space.createdByActorId,
        on_behalf_of_actor_id: space.onBehalfOfActorId, member_ids: space.memberIds,
        member_count: space.memberCount, rev: space.rev,
      })),
      chats: payload.chats.map(chat => ({
        id: chat.chatId, space_id: chat.spaceId, kind: chat.kind, name: chat.name,
        head_ord: chat.headOrd, head_rev: chat.headRev,
        chat_unread: chat.chatUnread,
        // Threads are Phase 4. Sent as zero rather than omitted, so the client
        // writes a complete row and the column never holds a stale value from
        // a previous session.
        thread_unread: 0,
        mention_count: chat.mentionCount,
      })),
      memberships: payload.memberships.map(membership => ({
        scope_type: membership.scopeType, scope_id: membership.scopeId,
        role: membership.role,
      })),
      streams: payload.streams,
      connections: payload.connections.map(c => ({
        id: c.id, toolkit: c.toolkit, status: c.status, status_reason: c.statusReason, label: c.label,
      })),
      agent_permissions: payload.agentPermissions.map(p => ({
        agent_actor_id: p.agentActorId, toolkit: p.toolkit, effect: p.effect, revoked: p.revoked,
      })),
      // Already the wire shape: a panel row is stored and sent as its event payload.
      panels: payload.panels,
      documents: payload.documents,
      timeline_entries: payload.timelineEntries,
    });

    // The two numbers §9.9's ceiling is made of, recorded together because
    // neither answers the question alone: bytes says how close we are, and
    // chats says what is driving it.
    recordWelcome(bytes, payload.chats.length);
    annotate({ welcome_bytes: bytes, chats: payload.chats.length,
               spaces: payload.spaces.length });
  }

  return {
    size: () => connections.size,
    registry,
    deliver: (event) => fanout(deps.db, registry, event),
    async close() {
      // Every connection told WHY, so clients reconnect with jitter instead of
      // discovering a dead socket at their next heartbeat. This is the half of
      // "a server restart disconnects everyone" that we control.
      for (const state of connections) state.bye(CLOSE.goingAway, 'server closing', 'server_closing');
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
/**
 * The part of a typing key that names the connection (ACTIVITY.md §0): the
 * server's own, never the client's, so nobody can type as somebody else's device.
 */
const typingKeyPrefix = (state: ConnectionState): string => `${state.actorId}:${state.id}:`;

let nextConnectionId = 0;

class ConnectionState implements Delivery {
  socket: WebSocket;
  /** This process's own name for the connection. Only ever compared, never trusted from a frame. */
  readonly id = (++nextConnectionId).toString(36);
  /** The activity frame being handled, so the next waits for it (see `onMessage`). Never rejects. */
  activity: Promise<void> = Promise.resolve();
  claims: SessionClaims | null = null;
  /** Set from `hello`. Text-only until a client says otherwise. */
  compress = false;
  readonly openedAt = Date.now();
  /**
   * Why this connection ended, set by whoever ended it.
   *
   * Recorded on the way OUT rather than derived from the close code, because
   * the code the client sees and the reason we closed are not the same
   * question: `goingAway` covers a shutdown and a silent socket alike, and
   * those are the two incidents a disconnect graph most needs to separate.
   *
   * DEFAULTS TO `client_stop`, because the default case is the peer hanging up
   * — a laptop closing, an app quitting — and `bye` is the only path by which
   * this server closes a socket. It defaulted to `error` at first, which made
   * every ordinary disconnect in a load run read as a fault: four hundred
   * `error` closes and not one `client_stop`, on the panel whose entire job is
   * telling a deploy apart from an incident.
   */
  closeReason = 'client_stop';
  disposed = false;
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
  drop(code: number, reason: string): void { this.bye(code, reason, 'slow_consumer'); }

  arm(ms: number, onExpiry: () => void): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(onExpiry, ms);
    // Otherwise an idle connection keeps the process alive through shutdown.
    this.#timer.unref?.();
  }

  /**
   * Write one frame, and report how many bytes it was.
   *
   * The byte count is returned rather than measured by the caller because this
   * is the only place the serialised frame exists — `welcome`'s size is the
   * number DESIGN §9.9's paging ceiling is about, and re-stringifying the body
   * to find it would double the cost of the largest frame we send.
   *
   * Assignable to `Delivery.send`, which declares `void`: TypeScript allows a
   * function that returns something where nothing is expected.
   */
  send(t: string, body: Record<string, unknown> = {}): number {
    // OPEN is checked because a close can land between deciding to send and
    // sending; `ws` throws on a closed socket, and that throw would surface
    // inside whatever unrelated handler happened to be running.
    if (this.socket.readyState !== this.socket.OPEN) return 0;
    // The reply carries the trace of the frame that caused it, so a client's
    // `ack` handling joins the span that assigned the ordinal instead of
    // starting a second trace nothing links to (OBSERVABILITY.md §4).
    const text = frame(t, body, traceparent());
    // Compressed frames go as BINARY, which is how the client tells them apart
    // — no envelope flag, because a flag would have to be read out of a payload
    // that has not been decompressed yet.
    if (this.compress && text.length > COMPRESS_ABOVE_BYTES) {
      const packed = gzipSync(text);
      this.socket.send(packed);
      // The COMPRESSED size, because that is what crosses the network and what
      // a ceiling on frame size has to be about.
      return packed.byteLength;
    }
    this.socket.send(text);
    return Buffer.byteLength(text);
  }

  /** Say goodbye and mean it: the timer goes even if the close never lands. */
  bye(code: number, reason: string, why = 'error'): void {
    this.closeReason = why;
    // NOT `dispose()`. That marks the connection departed, and the departure is
    // the `close` event that follows — disposing here would make `forget` treat
    // it as already counted and the disconnect would never be recorded.
    this.disarm();
    try { this.socket.close(code, reason); } catch { /* already gone */ }
  }

  disarm(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
  }
}

/**
 * A snapshot, in the shape the WIRE uses.
 *
 * THE BUG THIS EXISTS FOR, and it was live. `snapshotOf` returns the domain
 * shape — camelCase, because nothing in `feed.ts` knows a socket exists — and
 * the gap frame sent it through verbatim while the client read `author_id` and
 * `parent_id`. Every gap carrying messages therefore bound `undefined` into
 * SQLite and threw, on the one path that exists to rescue a client that has
 * fallen behind.
 *
 * Both sides had tests and both passed: each built its own fixtures in its own
 * convention, and `Gap.snapshot` is `.loose()` — deliberately, so a newer
 * server can add to it — which means zod validated nothing inside it. Nothing
 * checked that the two agreed until a load run did.
 *
 * A message here is byte-identical to a message in `backfill_ok`, and that is
 * asserted rather than hoped for: two shapes for "a message on the wire" is
 * what produced this in the first place.
 */
/**
 * A message row as it travels — one mapping for the tail, backfill, thread and
 * repair, so the four cannot drift apart (invariant 85). `visible_to` is null
 * for the whole chat; a list only ever reaches a reader who is on it.
 */
function rowOnWire(row: MessageRow): Record<string, unknown> {
  return {
    id: row.id, ord: row.ord, rev: row.rev, author_id: row.authorId,
    body: row.body, parent_id: row.parentId, deleted: row.deleted,
    edited_at: row.editedAt, reply_count: row.replyCount, visible_to: row.visibleTo,
    parts: row.parts,
  };
}

function onWire(snapshot: Snapshot): Record<string, unknown> {
  if (snapshot.kind === 'messages') {
    return {
      kind: 'messages',
      head_ord: snapshot.headOrd,
      recent: snapshot.recent.map(rowOnWire),
    };
  }
  if (snapshot.kind === 'space') {
    return {
      kind: 'space',
      space: {
        id: snapshot.space.id, kind: snapshot.space.kind, name: snapshot.space.name,
        slug: snapshot.space.slug, visibility: snapshot.space.visibility,
        membership_policy: snapshot.space.membershipPolicy,
        lifecycle: snapshot.space.lifecycle, created_by_actor_id: snapshot.space.createdByActorId,
        on_behalf_of_actor_id: snapshot.space.onBehalfOfActorId, member_ids: snapshot.space.memberIds,
        member_count: snapshot.space.memberCount, rev: snapshot.space.rev,
      },
      chats: snapshot.chats.map(chat => ({
        id: chat.id, space_id: chat.spaceId, kind: chat.kind, name: chat.name,
      })),
      members: snapshot.members,
    };
  }
  // The directory is deliberately not inlined — it is paged (invariant 71).
  return { kind: 'directory' };
}

/**
 * Turn a refusal into something a client can act on.
 *
 * `retryable` is the field that decides between backoff and a terminal failure,
 * and getting it wrong in either direction is bad in a different way. Mark a
 * permanent refusal retryable and the client spins for ever on a message that
 * will never send; mark a transient one terminal and it gives up on a message
 * that would have gone through a second later.
 *
 * So the default is RETRYABLE. An error nobody has classified is far more likely
 * to be a database hiccup than a permanent rule — and the cost of retrying
 * something permanent is visible, while the cost of discarding something
 * transient is a message the person believes they sent.
 */
function nackFor(opId: string, err: unknown): Record<string, unknown> {
  if (err instanceof Forbidden) {
    return {
      op_id: opId, code: 'forbidden', retryable: false,
      message: 'You do not have permission to do that here.',
    };
  }
  if (err instanceof PartsRefusedError) {
    // Not retryable: the same parts will be refused the same way. The message
    // names the reason and a closed-set detail — never the block's source.
    return {
      op_id: opId, code: 'parts_refused', retryable: false,
      message: err.detail ? `${err.reason}: ${err.detail}` : err.reason,
    };
  }
  if (err instanceof MessageNotFoundError) {
    return {
      op_id: opId, code: 'not_found', retryable: false,
      message: 'That message no longer exists.',
    };
  }
  return {
    op_id: opId, code: 'unavailable', retryable: true,
    message: (err as Error)?.message ?? 'Temporarily unavailable.',
  };
}
