// A high-volume mock run: real clients, real server, real telemetry.
//
//   node --env-file=.env scripts/mock/run.ts            # default size
//   node --env-file=.env scripts/mock/run.ts --wipe     # remove every mock world
//   MOCK_MINUTES=5 MOCK_CLIENTS=40 node ... run.ts      # bigger
//
// SEVENTY / THIRTY, deliberately. A load run that only exercises the happy path
// produces a dashboard where every panel is green and nothing has been learned;
// one that only exercises edge cases produces a dashboard where the ordinary
// case is invisible and every ratio is meaningless. The interesting numbers on
// the sync dashboard — the gap share, the replay size distribution, the retry
// rate — are all RATIOS, and a ratio needs both halves.
//
// The edge cases are provoked rather than waited for. A gap needs five hundred
// events to arrive while one client is away, and that does not happen by chance
// in five minutes; the scenario makes it happen and the engine is not told.
import { db, pool } from '../../apps/server/src/db/client.ts';
import { signAccessToken } from '../../apps/server/src/auth/tokens.ts';
import { ulid } from '../../apps/server/src/db/ulid.ts';
import { sql } from 'kysely';
import { useOtlpIfConfigured, count } from '@relayed/telemetry';
import { frame, PROTOCOL } from '@relayed/protocol';
import WebSocket from 'ws';
import { seed, wipe, mockOrgs, type World } from './world.ts';
import { MockClient } from './client.ts';

// Tagged as the desktop, because that is what these are. The server's own
// telemetry comes from the server process, and the two are told apart on every
// dashboard by `service_name`.
const otlp = useOtlpIfConfigured('desktop');

const SERVER = process.env['MOCK_SERVER'] ?? 'http://127.0.0.1:8787';
const WS = SERVER.replace(/^http/, 'ws') + '/sync';
const MINUTES = Number(process.env['MOCK_MINUTES'] ?? 4);
const CLIENTS = Number(process.env['MOCK_CLIENTS'] ?? 24);
const RATE = Number(process.env['MOCK_MSGS_PER_SEC'] ?? 60);
/** The share of ticks that provoke something unusual. */
const EDGE_SHARE = Number(process.env['MOCK_EDGE_SHARE'] ?? 0.30);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const chance = (p: number) => Math.random() < p;

const tally = new Map<string, number>();
const did = (what: string, n = 1): void => { tally.set(what, (tally.get(what) ?? 0) + n); };

// ── wipe ────────────────────────────────────────────────────────────────────

if (process.argv.includes('--wipe')) {
  const orgs = await mockOrgs(db);
  if (orgs.length === 0) console.log('nothing to wipe');
  for (const org of orgs) {
    const { events } = await wipe(db, org);
    console.log(`wiped ${org}: ${events.toLocaleString()} events and everything under it`);
  }
  await pool.end();
  process.exit(0);
}

// ── the world ───────────────────────────────────────────────────────────────

const reachable = await fetch(`${SERVER}/health`).then(r => r.ok).catch(() => false);
if (!reachable) {
  console.error(`no server at ${SERVER} — run \`pnpm --filter @relayed/server dev\` first`);
  await pool.end();
  process.exit(1);
}

console.log(`seeding a world for ${CLIENTS} clients…`);
const world: World = await seed(db, {
  actors: CLIENTS + 4,          // a few more actors than clients: some are never online
  channels: 14,
  privateChannels: 4,
});
console.log(`  org ${world.orgId} · ${world.actors.length} actors · ` +
            `${world.channels.length} channels · ${world.private.length} private`);

const token = (actorId: string) => signAccessToken({
  actorId, workspaceId: world.workspaceId, orgId: world.orgId,
  deviceId: `dev_mock_${actorId.slice(-6)}`, sessionId: `ses_mock_${actorId.slice(-6)}`,
});

const clients: MockClient[] = world.actors.slice(0, CLIENTS).map(actorId =>
  new MockClient({
    url: WS, actorId, workspaceId: world.workspaceId,
    token: () => token(actorId),
  }));

/** Chats a given actor may actually write to. Writing elsewhere is a refusal. */
const writableFor = (actorId: string): string[] => [
  ...world.channels.map(c => c.chatId),
  ...world.private.filter(p => p.members.includes(actorId)).map(p => p.chatId),
];
/** Private chats an actor is NOT in. The only way to produce a real refusal. */
const forbiddenFor = (actorId: string): string[] =>
  world.private.filter(p => !p.members.includes(actorId)).map(p => p.chatId);

for (const client of clients) client.start();
console.log('waiting for the fleet to be welcomed…');
await sleep(2_000);

const LINES = [
  'shipping the fix now', 'can you take a look at this?', 'deploy is green',
  'standup in 5', 'that graph looks wrong to me', 'agreed', 'nice one',
  'I think the cursor is stuck again', 'reverting for now',
  'has anyone seen the staging creds', 'lunch?', 'p95 is back under 100ms',
  'the migration took 40 seconds', 'lgtm', 'this is the third time today',
  'raising a PR shortly', 'who is on call this week', 'fixed in main',
];

// ── the ordinary case: 70% ──────────────────────────────────────────────────

function ordinary(): void {
  const client = pick(clients);
  const writable = writableFor(client.actorId);
  if (writable.length === 0) return;
  const chatId = pick(writable);

  // A real conversation is bursty: most people post once, some post three or
  // four times in a row. A flat one-per-tick would make every catch-up the same
  // size, and the replay-size distribution is one of the numbers worth having.
  const burst = chance(0.2) ? 2 + Math.floor(Math.random() * 3) : 1;
  for (let i = 0; i < burst; i++) {
    const id = client.send(chatId, LINES[Math.floor(Math.random() * LINES.length)]!);
    did('message.sent');
    // Sent, then thought better of. Online this is a real delete on the wire;
    // offline it coalesces and never reaches the network at all (invariant 6).
    if (chance(0.04)) { client.delete(chatId, id); did('message.deleted'); }
  }
}

// ── the edge cases: 30% ─────────────────────────────────────────────────────
//
// Each is named for the marker it should move, so a panel that stays flat after
// a run is a question rather than a mystery.

const EDGES: { name: string; weight: number; run: () => Promise<void> }[] = [
  {
    // → sync.catchup{answer=replay}, sync.catchup.events, sync.cursor.lag
    name: 'catch-up: away while a chat moves on',
    weight: 26,
    run: async () => {
      const client = pick(clients);
      const chatId = pick(writableFor(client.actorId));
      client.goOffline();
      // Under the 500-event gap threshold, deliberately: this is the case that
      // should REPLAY, and the run needs plenty of them for the gap share to
      // mean anything.
      await noise(chatId, 20 + Math.floor(Math.random() * 120));
      await sleep(150);
      client.goOnline();
      did('catchup');
    },
  },
  {
    // → sync.catchup{answer=gap}, sync.gap, sync.frame counters
    name: 'gap: away while a chat runs past the threshold',
    weight: 10,
    run: async () => {
      const client = pick(clients);
      const chatId = pick(writableFor(client.actorId));
      client.goOffline();
      // Over GAP_THRESHOLD (500). Written straight to the log rather than sent
      // through sockets: six hundred real messages would take a minute, and the
      // client cannot tell the difference — which is the point.
      await noise(chatId, 620);
      await sleep(200);
      client.goOnline();
      did('gap');
    },
  },
  {
    // → sync.backfill.page, and the floor moving down
    name: 'backfill: scrolling back through a gap',
    weight: 12,
    run: async () => {
      // A client that ACTUALLY has a gap, not a random one. Picking at random
      // meant most attempts found nothing to scroll back through, and the
      // scenario reported itself as running while doing nothing — the same
      // shape as an empty panel that reads as healthy.
      const gapped = clients
        .map(c => ({ client: c, chatId: c.gappedChat() }))
        .filter((g): g is { client: MockClient; chatId: string } => g.chatId !== null);
      if (gapped.length === 0) { did('backfill.nothing_gapped'); return; }
      const { client, chatId } = pick(gapped);
      // Several pages, the way a person scrolling actually behaves — one page
      // per flick, not one enormous fetch.
      for (let page = 0; page < 4; page++) {
        if (!client.scrollBack(chatId)) break;
        did('backfill.page');
        await sleep(120);
      }
    },
  },
  {
    // → sync.catchup{answer=gap} for a cursor BELOW the retention floor
    name: 'retention: a cursor beneath the horizon',
    weight: 5,
    run: async () => {
      const client = pick(clients);
      const chatId = pick(writableFor(client.actorId));
      client.goOffline();
      // Grow the log, then sweep a PREFIX of it — everything below a revision.
      //
      // A prefix, and that correction matters. The first version back-dated
      // forty events (which take the HIGHEST revisions) and deleted by time,
      // which punched a hole in the MIDDLE of the log. Catch-up's retention
      // guard checks the oldest retained revision, so it saw history below the
      // cursor and replayed — into a run with a hole in it. Every client staged
      // everything above the hole and stalled at the same revision, for ever.
      //
      // Production cannot produce that: the sweep deletes by time and time
      // correlates with revision, so it only ever removes a prefix. A fixture
      // that creates an impossible log tests a case that cannot happen while
      // breaking one that can.
      await noise(chatId, 60);
      const floor = await sql<{ rev: string }>`
        SELECT MIN(stream_rev) + 30 AS rev FROM sync_events
         WHERE stream_kind = 'chat' AND stream_id = ${chatId}::text
      `.execute(db);
      const below = Number(floor.rows[0]?.rev ?? 0);
      if (below > 0) {
        await sql`
          DELETE FROM sync_events
           WHERE stream_kind = 'chat' AND stream_id = ${chatId}::text
             AND stream_rev < ${below}::bigint
        `.execute(db);
      }
      await sleep(150);
      client.goOnline();
      did('retention.gap');
    },
  },
  {
    // → outbox.depth, outbox.oldest.age, outbox.op{settled=coalesced}
    name: 'offline compose: queue, coalesce, drain',
    weight: 16,
    run: async () => {
      const client = pick(clients);
      const chatId = pick(writableFor(client.actorId));
      client.goOffline();
      const queued: string[] = [];
      for (let i = 0; i < 3 + Math.floor(Math.random() * 6); i++) {
        queued.push(client.send(chatId, 'typed while the train was in a tunnel'));
        did('message.sent');
      }
      // Composed and deleted before it ever went. ZERO network operations, not
      // two that fail — the case coalescing exists for.
      if (queued.length > 1 && chance(0.6)) {
        client.delete(chatId, queued[queued.length - 1]!);
        did('coalesced');
      }
      await sleep(400 + Math.random() * 1_200);
      client.goOnline();
      did('offline.compose');
    },
  },
  {
    // → sync.op{result=error}, outbox.op{settled=failed}, a failed span
    name: 'refusal: writing into a private chat you are not in',
    weight: 8,
    run: async () => {
      const client = pick(clients);
      const forbidden = forbiddenFor(client.actorId);
      if (forbidden.length === 0) return;
      client.send(pick(forbidden), 'wrong room');
      did('refused.forbidden');
      await sleep(250);
      // A person meeting a red message: some retry, most give up.
      const { retried, discarded } = client.triage();
      did('outbox.retried', retried);
      did('outbox.discarded', discarded);
    },
  },
  {
    // → sync.op{result=error} with code=not_found
    name: 'refusal: deleting a message that never existed',
    weight: 4,
    run: async () => {
      const client = pick(clients);
      client.delete(pick(writableFor(client.actorId)), ulid('msg'));
      did('refused.not_found');
      await sleep(250);
      client.triage();
    },
  },
  {
    // → ws.closed{close=client_stop}, ws.connected{attempt}, a reconnect storm
    name: 'reconnect storm: everybody at once',
    weight: 3,
    run: async () => {
      const wave = clients.filter(() => chance(0.5));
      for (const client of wave) client.goOffline();
      await sleep(300);
      for (const client of wave) client.goOnline();
      did('reconnect.storm');
      did('reconnect.clients', wave.length);
    },
  },
  {
    // → sync.frame.dropped{frame=unknown}, invariant 43 working
    name: 'version skew: a frame this deployment predates',
    weight: 6,
    run: async () => {
      await raw(async (socket, actorId) => {
        socket.send(frame('hello', { protocol: PROTOCOL, access_token: await token(actorId) }));
        await sleep(300);
        socket.send(frame('reaction.added', { id: ulid('rct'), emoji: '🎉' }));
        socket.send(frame('thread.subscribed', { t: ulid('thr') }));
        await sleep(200);
      });
      did('frame.unknown');
    },
  },
  {
    // → sync.frame.dropped{frame=malformed}
    name: 'a broken frame, from a connection that is otherwise fine',
    weight: 4,
    run: async () => {
      await raw(async (socket, actorId) => {
        socket.send(frame('hello', { protocol: PROTOCOL, access_token: await token(actorId) }));
        await sleep(300);
        socket.send('{"t":"op","op_id":');          // truncated JSON
        socket.send(frame('op', { op_id: 'x' }));   // right type, wrong body
        await sleep(200);
      });
      did('frame.malformed');
    },
  },
  {
    // → ws.closed{close=too_old}
    name: 'a client too old to sync',
    weight: 2,
    run: async () => {
      await raw(async (socket) => {
        socket.send(frame('hello', { protocol: 0, access_token: 'irrelevant' }));
        await sleep(300);
      });
      did('protocol.too_old');
    },
  },
  {
    // → ws.closed{close=unauthenticated}
    name: 'a token the server will not take',
    weight: 3,
    run: async () => {
      await raw(async (socket) => {
        socket.send(frame('hello', { protocol: PROTOCOL, access_token: 'not.a.token' }));
        await sleep(300);
      });
      did('auth.rejected');
    },
  },
  {
    // → ws.closed{close=hello_timeout}
    name: 'a socket that connects and never speaks',
    weight: 2,
    run: async () => {
      await raw(async () => { await sleep(400); });
      did('hello.silent');
    },
  },
  {
    // → sync.op replay, invariant 5. The same op twice, as a lost ack produces.
    name: 'duplicate: the same op_id sent twice',
    weight: 5,
    run: async () => {
      const actorId = pick(world.actors);
      const chatId = pick(writableFor(actorId));
      const opId = ulid('op');
      const target = ulid('msg');
      await raw(async (socket) => {
        socket.send(frame('hello', { protocol: PROTOCOL, access_token: await token(actorId) }));
        await sleep(400);
        const op = frame('op', { op_id: opId, kind: 'send', c: chatId, target,
                                 m: { body: 'sent twice, stored once' } });
        socket.send(op);
        await sleep(200);
        socket.send(op);            // the retry a lost ack causes
        await sleep(300);
      }, actorId);
      did('op.duplicate');
    },
  },
  {
    // → sync.directory.hydrate, directory.synced. A device nobody has used.
    name: 'a brand new device, with an empty replica',
    weight: 4,
    run: async () => {
      const actorId = pick(world.actors);
      const fresh = new MockClient({
        url: WS, actorId, workspaceId: world.workspaceId, token: () => token(actorId),
      });
      fresh.start();
      await sleep(1_500);
      fresh.stop();
      did('device.fresh');
    },
  },
];

const TOTAL_WEIGHT = EDGES.reduce((n, e) => n + e.weight, 0);

function anEdge(): { name: string; run: () => Promise<void> } {
  let at = Math.random() * TOTAL_WEIGHT;
  for (const edge of EDGES) {
    at -= edge.weight;
    if (at <= 0) return edge;
  }
  return EDGES[0]!;
}

// ── helpers the scenarios use ───────────────────────────────────────────────

/**
 * Put `n` events on a chat's log directly, as if other people had posted them.
 *
 * NOT through the socket, and the difference is only speed: six hundred real
 * sends take a minute of wall clock, and a client that is offline cannot tell
 * the two apart — its cursor is behind by the same amount either way. The
 * server's `next_rev` is advanced with them so the head is honest.
 */
async function noise(chatId: string, n: number): Promise<void> {
  // BOTH COUNTERS, in one statement, exactly as `allocateChat` does. They are
  // different numbers and the first version of this used the revision as the
  // ordinal — which collided with ordinals real sends had already allocated,
  // and every client applying the batch hit `UNIQUE(chat_id, ord)`. The two
  // counters being independent is the whole two-counter model (DESIGN §8.1);
  // a fixture that conflates them produces a log the server could never write.
  const { rows } = await sql<{ next_rev: string; next_ord: string }>`
    UPDATE chats SET next_rev = next_rev + ${n}::bigint,
                     next_ord = next_ord + ${n}::bigint
     WHERE id = ${chatId} RETURNING next_rev, next_ord
  `.execute(db);
  const to = Number(rows[0]?.next_rev ?? n);
  const from = to - n;
  const ordFrom = Number(rows[0]?.next_ord ?? n) - n;
  // EVERY parameter cast, because Postgres infers a parameter's type from where
  // it is used and `$1 + i` inside `jsonb_build_object` gives it nowhere to look
  // — "could not determine data type of parameter $6", which is what the first
  // version of this did on every single call.
  await sql`
    INSERT INTO sync_events
      (event_id, workspace_id, stream_kind, stream_id, stream_rev, event_type, payload)
    SELECT ${ulid('evt')}::text || lpad(i::text, 7, '0'), ${world.workspaceId}::text,
           'chat', ${chatId}::text, ${from}::bigint + i, 'message.created',
           jsonb_build_object('id', 'msg_noise_' || ${chatId}::text || '_' || i,
                              'ord', ${ordFrom}::bigint + i,
                              'parent_id', NULL, 'author_id', ${world.actors[0]!}::text,
                              'body', 'backfill filler ' || i,
                              'created_at', now())
      FROM generate_series(1, ${n}::int) i
  `.execute(db);
  did('noise.events', n);
}

/**
 * A hand-driven socket, for the frames the engine would never send.
 *
 * Unknown types, malformed bodies, an ancient protocol, a duplicate op. None of
 * these can come from `createLink` — which is the point of it — so they are
 * produced the only way a real misbehaving peer would.
 */
async function raw(
  drive: (socket: WebSocket, actorId: string) => Promise<void>,
  actorId = pick(world.actors),
): Promise<void> {
  const socket = new WebSocket(WS);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await drive(socket, actorId);
  } catch { did('raw.failed'); }
  finally { try { socket.close(); } catch { /* already gone */ } }
}

// ── the run ─────────────────────────────────────────────────────────────────

const until = Date.now() + MINUTES * 60_000;
const tickMs = Math.max(5, Math.floor(1_000 / RATE));
let ticks = 0;
/** One line per scenario that fails, so a broken one is not just a number. */
const reported = new Set<string>();
/** Edge scenarios currently running. Bounded, or a storm compounds itself. */
const running = new Set<Promise<void>>();

console.log(`running for ${MINUTES} min at ~${RATE}/s, ` +
            `${Math.round(EDGE_SHARE * 100)}% edge cases. Ctrl-C to stop early.\n`);

let stopping = false;
process.once('SIGINT', () => { stopping = true; });

const started = Date.now();
let lastReport = started;

while (Date.now() < until && !stopping) {
  ticks++;
  if (chance(EDGE_SHARE) && running.size < 6) {
    const edge = anEdge();
    const job = edge.run().catch((e: unknown) => {
      did('edge.failed');
      // The FIRST failure of each scenario, printed once. A run that
      // silently swallowed them would report an edge share it never
      // actually produced, which is worse than no run at all.
      if (!reported.has(edge.name)) {
        reported.add(edge.name);
        console.error(`  ✗ ${edge.name}: ${(e as Error)?.message ?? String(e)}`);
      }
    });
    running.add(job);
    void job.finally(() => running.delete(job));
  } else {
    ordinary();
  }

  // Somebody triages their failures every so often, and somebody scrolls.
  if (ticks % 400 === 0) {
    const client = pick(clients);
    const gapped = client.gappedChat();
    if (gapped) { client.scrollBack(gapped); did('backfill.page'); }
  }

  if (Date.now() - lastReport > 15_000) {
    lastReport = Date.now();
    const queued = clients.reduce((n, c) => n + c.queued(), 0);
    const lag = Math.max(...clients.map(c => c.worstLag()));
    const left = Math.round((until - Date.now()) / 1_000);
    console.log(`  ${fmt(tally)} · queued ${queued} · worst lag ${lag} · ${left}s left`);
  }

  await sleep(tickMs);
}

// ── settle, then report ─────────────────────────────────────────────────────

console.log('\ndraining…');
await Promise.allSettled([...running]);
// Long enough for the last acks, the last catch-up replies, and one heartbeat
// carrying cursors — the frame that closes the commit-to-socket residue.
for (const client of clients) client.goOnline();
// LONG ENOUGH FOR A HEARTBEAT, which is 25s. Events injected straight into the
// log are never fanned out, so a client learns about them from the `pong` that
// carries stream heads — the frame that bounds the commit-to-socket residue.
// Draining for four seconds reported a worst lag of several hundred every time
// and made a working mechanism look like a stall.
const settleMs = Number(process.env['MOCK_SETTLE_MS'] ?? 32_000);
for (let waited = 0; waited < settleMs; waited += 4_000) {
  await sleep(4_000);
  const lag = Math.max(...clients.map(c => c.worstLag()));
  const left = clients.reduce((n, c) => n + c.queued(), 0);
  console.log(`  settling · worst lag ${lag} · queued ${left}`);
  if (lag === 0 && left === 0) break;
}

const queued = clients.reduce((n, c) => n + c.queued(), 0);
const worst = Math.max(...clients.map(c => c.worstLag()));
const events = await db.selectFrom('sync_events')
  .select(({ fn }) => fn.countAll<string>().as('n'))
  .where('workspace_id', '=', world.workspaceId).executeTakeFirst();

console.log('\n─────────────────────────────────────────────');
console.log(`ticks            ${ticks.toLocaleString()}`);
for (const [what, n] of [...tally].sort((a, b) => b[1] - a[1])) {
  console.log(`${what.padEnd(16)} ${n.toLocaleString()}`);
}
console.log('─────────────────────────────────────────────');
console.log(`sync_events      ${Number(events?.n ?? 0).toLocaleString()}`);
console.log(`outbox left      ${queued}`);
console.log(`worst lag        ${worst}`);
if (worst > 0 || queued > 0) {
  // A run that did not converge must say WHY, per client. "Worst lag 464" is a
  // number; "three clients in backoff on one chat" is a cause.
  console.log('\nnot converged:');
  for (const d of clients.map(c => c.diagnose()).filter(d => d.lag > 0 || d.queued > 0)) {
    console.log(`  ${d.actor}  ${d.state.padEnd(12)} lag ${String(d.lag).padStart(5)} ` +
                `on ${d.worst}  queued ${d.queued}`);
  }
}
console.log(`org              ${world.orgId}   (wipe with --wipe)`);
console.log('─────────────────────────────────────────────');
console.log('\nGrafana:  http://localhost:3000/d/relayed-phase2/relayed-sync');

// A counter the dashboard can show for the run itself, so a panel that looks
// empty can be told apart from a run that never happened.
count('sync.frame.dropped', { frame: 'unknown' }, 0);

for (const client of clients) client.stop();
// A beat before the replicas go, for the chunked applies still in flight.
await sleep(500);
for (const client of clients) client.close();
await otlp?.flush();
await pool.end();
process.exit(0);

function fmt(counts: Map<string, number>): string {
  return ['message.sent', 'catchup', 'gap', 'backfill.page', 'offline.compose']
    .map(k => `${k} ${(counts.get(k) ?? 0).toLocaleString()}`).join(' · ');
}

