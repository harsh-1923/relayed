// The read path's domain layer: head state, catch-up, gaps, backfill, counters
// and the `welcome` payload. Phase 2 step C (PHASE-2-SYNC.md §3).
//
// Ported from `spikes/sync-model.mjs`, which is the acceptance suite rather
// than a sketch. Ported, not transliterated: three of its statements are
// correct only because it runs one single-threaded in-memory SQLite connection
// or uses SQLite spellings, and each is named where it changed.
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { type Stream } from './events.ts';
import { spaceMembers } from './spaces.ts';
import { retainedFrom } from './retention.ts';
import { visibleTo, redactEvent } from './visibility.ts';
import { agentSummaries } from '../agents/summary.ts';
import type { AgentSummary } from './events.ts';

/**
 * How far behind a client may be before catch-up becomes a gap marker.
 *
 * MEASURED, and the measurement changed what the number means rather than the
 * number itself. Replaying from a 5,000-event log, on a laptop against local
 * Postgres:
 *
 *   revs |  bytes | server ms | bytes/rev
 *   -----+--------+-----------+----------
 *     50 |   13 K |       1.1 |     265 B
 *    250 |   65 K |       1.4 |     265 B
 *    500 |  129 K |       1.5 |     265 B
 *   5000 |  129 K |       2.5 |   capped
 *
 * Two things fall out. **The server is not the constraint** — one to three
 * milliseconds whatever the size, so tuning this to protect the database would
 * be tuning the wrong thing. And **the wire is**: at this threshold a single
 * replay is 129 KB, which is comparable to the whole `welcome` frame we went to
 * some trouble to shrink — and a client reconnecting after a deploy asks on
 * every stream it is behind on, not one.
 *
 * The number is RE-AFFIRMED rather than replaced, because what would actually
 * settle it is a distribution of how far behind real clients are, and there is
 * no traffic yet to take one from. What the measurement does settle is the
 * relationship below.
 */
export const GAP_THRESHOLD = 500;

/**
 * The most events one replay may carry.
 *
 * TIED TO THE THRESHOLD ON PURPOSE, rather than being a second constant that
 * happens to match. Raise the threshold alone and a replay is silently capped
 * here — the client is told it may replay 900 revisions and sent 500. That is
 * survivable now only because `toRev` reports what was DELIVERED rather than
 * the head (a second round finishes the job), and it was a silent permanent
 * hole before that fix.
 *
 * Equal, not merely related: a client that may replay N must be able to receive
 * N. Deriving one from the other is what stops the two drifting apart in a
 * commit that only meant to tune one of them.
 */
export const REPLAY_LIMIT = GAP_THRESHOLD;

/** How much recent history rides along with a gap marker. */
const GAP_TAIL = 50;

export interface Head {
  headOrd: number;
  headRev: number;
}

export interface Counters {
  chatUnread: number;
  mentionCount: number;
}

/**
 * A message as every row-returning path sends it: COMPLETE CURRENT STATE.
 *
 * The body as it stands, whether it is a tombstone, when it was edited, and
 * how many replies it has — one shape for the gap tail, backfill, the thread
 * page and repair. A client that already holds the row overwrites what it has
 * with this, which is only safe because nothing is missing from it: a path
 * that sent the body but not the tombstone flag would un-delete a message on
 * every device that was far behind when it was deleted (invariant 85).
 */
export interface MessageRow {
  id: string;
  ord: number;
  /** The message's VERSION: the revision of its last visible change (events.ts, the version rule). */
  rev: number;
  authorId: string;
  body: string;
  parentId: string | null;
  deleted: boolean;
  editedAt: string | null;
  /** Undeleted replies THIS READER may see — a restricted reply is not counted for someone it is hidden from. */
  replyCount: number;
  /** Null for the whole chat; else the list, which this reader is necessarily on. */
  visibleTo: string[] | null;
  /** The parts `body` was derived from, as stored; null for a message that is its body. */
  parts: unknown[] | null;
}

/**
 * One entry from the log, in the shape it goes on the wire.
 *
 * `type` is a plain string rather than the writer's closed union on purpose:
 * this is a READ, and a reader of an old row must tolerate an event type that
 * has since been added or retired. The client is required to do the same — an
 * unknown event type still advances the cursor (invariant 32) — and typing the
 * read side as a closed union here would be the server making a promise the
 * protocol explicitly refuses to make.
 */
export interface Event {
  rev: number;
  type: string;
  payload: unknown;
}

/**
 * What a client too far behind gets instead of a replay.
 *
 * DISCRIMINATED BY STREAM KIND, because "what does a client render while it is
 * behind" has a different answer for each. A chat's answer is its newest
 * messages; a space's is its current shape; the directory's is a paged snapshot
 * too large to inline. An earlier version returned a message tail for every
 * stream, which is meaningless for the two that carry no messages.
 */
export type Snapshot =
  /** The newest messages, oldest-first so the client renders them in order. */
  | { kind: 'messages'; headOrd: number; recent: MessageRow[] }
  /** A space's current shape: the row, its chats, and who is in it. */
  | { kind: 'space'; space: WelcomeSpace; chats: ChatRow[]; members: string[] }
  /**
   * The directory, which is NOT inlined.
   *
   * At 1,600 members it is 345 KB — the exact collection invariant 71 exists to
   * keep out of a frame. The client pages it with keyset requests instead, and
   * this says only that it must (step 10 of the plan).
   */
  | { kind: 'directory' };

export interface ChatRow {
  id: string;
  spaceId: string;
  kind: string;
  name: string | null;
}

export type Catchup =
  | { kind: 'replay'; stream: Stream; fromRev: number; toRev: number; events: Event[] }
  | { kind: 'gap'; stream: Stream; headRev: number; snapshot: Snapshot };

/** The last allocated ordinal and revision. Zero on a chat nothing has touched. */
export async function head(db: Kysely<DB>, chatId: string): Promise<Head> {
  const row = await db.selectFrom('chats').select(['next_ord', 'next_rev'])
    .where('id', '=', chatId).executeTakeFirst();
  return { headOrd: row?.next_ord ?? 0, headRev: row?.next_rev ?? 0 };
}

/**
 * The head revision of any stream.
 *
 * Zero for a stream that does not exist, which reads the same as one nothing has
 * happened in — and that is the right answer either way: a client asking about
 * a stream it cannot see should learn nothing from the difference.
 */
export async function streamHead(db: Kysely<DB>, stream: Stream): Promise<number> {
  if (stream.kind === 'chat') return (await head(db, stream.id)).headRev;
  const table = stream.kind === 'space' ? 'spaces' : 'workspaces';
  const row = await db.selectFrom(table).select('next_rev')
    .where('id', '=', stream.id).executeTakeFirst();
  return row?.next_rev ?? 0;
}

/**
 * Every change with `rev > fromRev`, in revision order, from the log.
 *
 * One stream carrying every kind of change, which is the whole reason `rev`
 * exists apart from `ord`: catch-up is uniform, so a client asks one question
 * per stream rather than one per kind of change (DESIGN.md §8.1).
 *
 * READS THE LOG, not the rows it describes, and the difference is not an
 * optimisation. Derived from `messages` — which is what this did before the log
 * existed — a chat where m1 was created at rev 1 and edited at rev 3 returns
 * ONE row carrying rev 3, and revision 1 exists nowhere: the creation was
 * overwritten by its own edit. Worse in this phase, a space rename or a
 * membership change is not in `messages` at all and had no catch-up path
 * whatsoever (docs/SYNC-FLOWS.md §12.1).
 *
 * Generic over streams for the same reason: a chat, a space and the workspace
 * directory are all just sequences of events, so one query serves all three.
 *
 * The limit is a floor under a pathological read, not paging: `catchup` decides
 * gap-versus-replay first, so a replay is already bounded by the threshold.
 */
export async function eventsSince(
  db: Kysely<DB>, readerId: string, stream: Stream, fromRev: number, limit = REPLAY_LIMIT,
): Promise<Event[]> {
  const rows = await db.selectFrom('sync_events')
    .select(['stream_rev', 'event_type', 'payload', 'visible_to'])
    .where('stream_kind', '=', stream.kind)
    .where('stream_id', '=', stream.id)
    .where('stream_rev', '>', fromRev)
    // An exact prefix seek on the unique index, which is why there is no second
    // index on these columns (008_sync_events.sql).
    .orderBy('stream_rev')
    .limit(limit)
    .execute();

  // REDACTED, NOT FILTERED. A row this reader may not see comes back as its
  // revision alone, and it has to come back: skipped, the reader's frontier
  // would find a hole at that revision, ask for it again, and never be given it
  // — the chat would stop updating for them for good (WORKSPACE-AGENTS.md §8.3).
  return rows.map((row): Event => redactEvent(row, readerId));
}

/**
 * Bring a client up to date, or tell it that it cannot be.
 *
 * This is what bounds a reconnect to O(chats) rather than O(messages): a client
 * a week behind across 150 chats gets one small frame per chat instead of a
 * hundred thousand messages (DESIGN.md §9.3).
 *
 * The gap reply is not an error and not a degraded mode. The client stores the
 * tail, sets `has_gap`, and jumps its cursor to the head; the history below is
 * backfilled lazily when somebody actually opens the chat.
 *
 * Asked AS A READER, because what a replay or a tail may contain depends on who
 * is asking once some messages are for some people (WORKSPACE-AGENTS.md §8.7).
 */
export async function catchup(
  db: Kysely<DB>, readerId: string, stream: Stream, fromRev: number,
  threshold = GAP_THRESHOLD,
): Promise<Catchup> {
  const headRev = await streamHead(db, stream);

  if (headRev - fromRev > threshold) {
    return { kind: 'gap', stream, headRev, snapshot: await snapshotOf(db, readerId, stream) };
  }

  // TOO FAR BEHIND IS NOT ONLY ABOUT DISTANCE. A client can be well inside the
  // threshold and still unreplayable, because retention swept the events it
  // needs. Revisions are gapless per stream, so "is rev fromRev + 1 still
  // here" settles it completely.
  //
  // Without this check the failure is silent and permanent: the client gets a
  // replay starting above its frontier, finds a hole, stages it, and asks
  // again — for ever. Swept entirely it is worse, an EMPTY replay whose
  // `to_rev` equals the cursor that was sent, which reads exactly like being
  // caught up while the head runs away.
  if (headRev > fromRev) {
    const oldest = await retainedFrom(db, stream);
    if (oldest === null || oldest > fromRev + 1) {
      return { kind: 'gap', stream, headRev, snapshot: await snapshotOf(db, readerId, stream) };
    }
  }

  const events = await eventsSince(db, readerId, stream, fromRev);

  // `toRev` is what the client's frontier BECOMES once this batch applies, so
  // it is derived from what was actually delivered — never from the head.
  //
  // Those are the same number today only because the replay threshold and
  // `eventsSince`'s limit happen to be the same constant. They are two
  // constants, and this step exists partly to retune the first with real
  // traffic. Tune it upward against a fixed limit and `toRev: headRev` would
  // tell a client its frontier had reached the head when only the first 500
  // events were sent — advancing it past events it never received, which is a
  // silent permanent hole and the exact failure the contiguity rule exists to
  // prevent (invariant 1).
  //
  // Empty falls back to `fromRev`, not `headRev`: nothing arrived, so nothing
  // moves.
  const toRev = events.length > 0 ? (events.at(-1) as Event).rev : fromRev;

  return { kind: 'replay', stream, fromRev, toRev, events };
}

/**
 * Current state for a client that has fallen past the replay horizon.
 *
 * Jumping a frontier past revisions never seen is safe precisely BECAUSE this
 * is current state rather than a partial history. Anything below it is not
 * missing-and-unknown, it is missing-and-marked — the client records where the
 * floor is and backfill repairs it on demand.
 */
async function snapshotOf(db: Kysely<DB>, readerId: string, stream: Stream): Promise<Snapshot> {
  if (stream.kind === 'chat') {
    // Tombstones INCLUDED. Not for the client's own held rows — repair corrects
    // those — but because a deleted root still has a thread: a root created and
    // deleted while the client was away, whose replies survive, is reachable
    // only through its tombstone. (Established by a planted bug in the sync
    // model that nothing caught until that trace was written.)
    const rows = await messageRows(db, readerId)
      .where('m.chat_id', '=', stream.id)
      .orderBy('m.ord', 'desc')
      .limit(GAP_TAIL)
      .execute();
    const { headOrd } = await head(db, stream.id);
    return {
      kind: 'messages', headOrd,
      // Newest-first from the database, oldest-first to the client: it renders
      // in ordinal order, and reversing here means every caller does not.
      recent: rows.reverse().map(toMessage),
    };
  }

  // The directory is deliberately NOT inlined — at 1,600 members it is the
  // 345 KB collection invariant 71 exists to keep out of a frame.
  if (stream.kind === 'workspace') return { kind: 'directory' };

  const [space, chats, members] = await Promise.all([
    db.selectFrom('spaces')
      .select(['id', 'kind', 'name', 'slug', 'visibility', 'membership_policy',
               'lifecycle', 'next_rev'])
      .where('id', '=', stream.id).executeTakeFirst(),
    db.selectFrom('chats').select(['id', 'space_id', 'kind', 'name'])
      .where('space_id', '=', stream.id).execute(),
    spaceMembers(db, stream.id),
  ]);

  // A space that no longer exists still gets a well-formed snapshot rather than
  // an error: the client has been told it is behind, and the honest answer is
  // "there is nothing here now".
  return {
    kind: 'space',
    space: space
      ? {
          id: space.id, kind: space.kind, name: space.name, slug: space.slug,
          visibility: space.visibility, membershipPolicy: space.membership_policy,
          lifecycle: space.lifecycle, rev: space.next_rev,
        }
      : {
          id: stream.id, kind: 'channel', name: null, slug: null,
          visibility: null, membershipPolicy: 'invite', lifecycle: 'archived', rev: 0,
        },
    chats: chats.map(chat => ({
      id: chat.id, spaceId: chat.space_id, kind: chat.kind, name: chat.name,
    })),
    members,
  };
}


/**
 * One page of history below an ordinal, newest first.
 *
 * Keyset on `ord`, never OFFSET: offset paging degrades linearly and, worse,
 * skips or repeats rows when anything is inserted mid-scroll (DESIGN.md §11.3).
 *
 * Thread replies are excluded — the chat view is top-level messages, and the
 * partial index `msg_chat_view` is what stops a thread with 800 replies being
 * scanned to find 50 chat messages.
 */
export async function backfill(
  db: Kysely<DB>, readerId: string, chatId: string, beforeOrd: number, limit = 50,
): Promise<MessageRow[]> {
  // Tombstoned roots included, for the reason the gap tail includes them: a
  // deleted root's thread is reachable only through it. Every filter here runs
  // in SQL, before the LIMIT — a row dropped afterwards would make a short page
  // read as the beginning of history (the rule WORKSPACE-AGENTS.md §8.7 names).
  const rows = await messageRows(db, readerId)
    .where('m.chat_id', '=', chatId)
    .where('m.parent_id', 'is', null)
    .where('m.ord', '<', beforeOrd)
    .orderBy('m.ord', 'desc')
    .limit(limit)
    .execute();
  return rows.map(toMessage);
}

/**
 * REPAIR: everything that changed after `sinceRev` among the messages a client
 * could already hold, as complete rows, keyset-paged by (rev, id).
 *
 * The question a client asks after a gap. A gap replaced the log with a partial
 * snapshot — the newest messages — and a message the client held that the
 * snapshot did not re-send is otherwise never corrected: a delete during the
 * gap leaves the message on that device for good (the finding that led here,
 * WORKSPACE-AGENTS-IMPL.md §4.1.1). This is what the version rule exists to
 * answer: `rev > sinceRev` is "changed while I was away", `ord <= maxOrd` is
 * "and old enough that I might hold it", and `msg_rev (chat_id, rev)` makes the
 * scan proportional to what changed rather than to history.
 *
 * Paged by (rev, id) rather than by ord, and that is load-bearing: a row that
 * changes AGAIN after a page was computed moves past the cursor and is served
 * again at its new version — which is how a client that applied a live change
 * over a stale row gets the row corrected (SYNC-FLOWS.md, the repair flow).
 */
export async function repair(
  db: Kysely<DB>, readerId: string, chatId: string, sinceRev: number, maxOrd: number,
  after: { rev: number; id: string } | null, limit = 50,
): Promise<MessageRow[]> {
  const rows = await messageRows(db, readerId)
    .where('m.chat_id', '=', chatId)
    .where('m.rev', '>', sinceRev)
    .where('m.ord', '<=', maxOrd)
    .$if(after !== null, qb => qb.where(eb => eb.or([
      eb('m.rev', '>', (after as { rev: number }).rev),
      eb.and([eb('m.rev', '=', (after as { rev: number }).rev),
              eb('m.id', '>', (after as { id: string }).id)]),
    ])))
    .orderBy('m.rev')
    .orderBy('m.id')
    .limit(limit)
    .execute();
  return rows.map(toMessage);
}

/**
 * One page of a thread, by ordinal — the parent-keyed read DESIGN.md §8.2 says
 * must exist from day one, because replies share the chat's ordinal space and
 * so cannot be fetched by the chat's ordinal range.
 *
 * Undeleted replies only. A tombstone is owed only for a row the client holds,
 * a held reply deleted meanwhile is corrected by repair, and a reply has no
 * thread of its own — so nothing hangs off a deleted reply that the client
 * would need the row to reach. A planted bug that dropped them here survived
 * every check in the sync model, which is how this was established.
 */
export async function threadReplies(
  db: Kysely<DB>, readerId: string, chatId: string, rootId: string, afterOrd: number,
  limit = 50,
): Promise<MessageRow[]> {
  const rows = await messageRows(db, readerId)
    .where('m.chat_id', '=', chatId)
    .where('m.parent_id', '=', rootId)
    .where('m.deleted', '=', false)
    .where('m.ord', '>', afterOrd)
    .orderBy('m.ord')
    .limit(limit)
    .execute();
  return rows.map(toMessage);
}

/**
 * The one SELECT every row-returning path starts from, so neither the row shape
 * nor WHO MAY SEE A ROW can differ between them.
 *
 * The visibility clause is here rather than at each caller, and it is a WHERE
 * — so it runs before whatever LIMIT the caller adds (invariant 79). The reply
 * count is narrowed the same way: a restricted reply is a reply its unlisted
 * readers cannot open, and counting it would promise them one.
 */
function messageRows(db: Kysely<DB>, readerId: string) {
  return db.selectFrom('messages as m')
    .select(['m.id', 'm.ord', 'm.rev', 'm.author_id', 'm.body', 'm.parent_id',
             'm.deleted', 'm.edited_at', 'm.visible_to', 'm.parts'])
    .select(eb => eb.selectFrom('messages as r')
      .select(eb2 => eb2.fn.countAll<number>().as('n'))
      .whereRef('r.parent_id', '=', 'm.id')
      .where('r.deleted', '=', false)
      .where(visibleTo('r', readerId))
      .as('reply_count'))
    .where(visibleTo('m', readerId));
}

/**
 * Unread and mention counts for one actor in one chat.
 *
 * COMPUTED, not materialised — a deliberate narrowing of DESIGN.md §12's
 * "updated on write", and the one place this phase diverges from the letter of
 * the design. The reasoning: maintaining a counter per member per message means
 * a write touching every member row, and four separate invalidation paths
 * (send, delete, read, join) each of which is a chance to be quietly wrong. A
 * count over an indexed range is correct by construction and needs none of
 * them. `chat_read_state` already carries the columns, so materialising later
 * is a change to this function rather than a migration — and the trigger to do
 * it is `welcome` latency, which step E is where it becomes measurable.
 *
 * All three exclusions matter. Your own messages are not unread to you, a
 * tombstone is not unread to anyone, and a message you may not see is not
 * unread to you either — which is also why the arithmetic fallback
 * `headOrd - lastReadOrd` can only ever be a sanity check: it cannot see any of them.
 */
export async function counters(
  db: Kysely<DB>, chatId: string, actorId: string,
): Promise<Counters> {
  const read = await db.selectFrom('chat_read_state').select('last_read_ord')
    .where('chat_id', '=', chatId).where('actor_id', '=', actorId)
    .executeTakeFirst();
  const lastRead = read?.last_read_ord ?? 0;

  const mention = mentionPattern(actorId);

  const row = await db.selectFrom('messages')
    .select([
      db.fn.countAll<number>().as('unread'),
      sql<number>`count(*) FILTER (WHERE body LIKE ${mention})`.as('mentions'),
    ])
    .where('chat_id', '=', chatId)
    .where('ord', '>', lastRead)
    .where('deleted', '=', false)
    .where('author_id', '!=', actorId)
    // A badge for a message the reader can never open is worse than wrong when
    // it is the newest: reading the chat marks read up to the highest ordinal
    // they HOLD, which is below it, and the badge never clears (§8.7).
    .where(visibleTo('messages', actorId))
    .executeTakeFirstOrThrow();

  return { chatUnread: row.unread, mentionCount: row.mentions };
}

export interface WelcomeChat extends Head, Counters {
  chatId: string;
  spaceId: string;
  kind: string;
  name: string | null;
}

export interface WelcomeSpace {
  id: string;
  kind: string;
  name: string | null;
  slug: string | null;
  visibility: string | null;
  membershipPolicy: string;
  lifecycle: string;
  rev: number;
}

export interface WelcomeMembership {
  scopeType: string;
  scopeId: string;
  role: string;
}

export interface WelcomeStream {
  kind: string;
  id: string;
  rev: number;
}

/**
 * Everything a client needs to paint a correct sidebar, before it holds a
 * single message.
 *
 * Four collections, and what is NOT here is the point (invariant 71): no actor
 * directory, and no spaces this actor has not joined. Both would be sized by
 * the workspace rather than by the person, which is how a frame that is fine at
 * a hundred people becomes half a megabyte at sixteen hundred (DESIGN.md §9.9).
 */
export interface WelcomePayload {
  spaces: WelcomeSpace[];
  chats: WelcomeChat[];
  memberships: WelcomeMembership[];
  streams: WelcomeStream[];
}

/**
 * How a mention of an actor looks in a stored body.
 *
 * Messages use a canonical Markdown application link whose target is the
 * actor id. Its label is only a human-readable fallback; identity and mention
 * counting depend on the durable target.
 *
 * Defined once because two paths count mentions, and a pattern that differed
 * between them would make a badge disagree with itself depending on whether it
 * arrived in `welcome` or in a later `counters` push.
 */
const mentionPattern = (actorId: string): string => `%](actor:${actorId})%`;

/**
 * Head state and counters for every chat an actor can reach in a workspace.
 *
 * After this one exchange every badge in the sidebar is correct, before a
 * single message body has been fetched. That is R2 satisfied, cheaply — and it
 * is why the counters must not require the client to hold the messages they
 * count.
 *
 * ONE query, deliberately. The obvious shape — list the chats, then count each
 * one — was 301 statements for 150 chats, and the cost was never the counting:
 * measured, the work is ~18 ms either way and the round trips are everything.
 * That matters here more than anywhere else in the system, because `welcome`
 * runs on every reconnect and reconnects arrive together after a deploy. At the
 * ~333 reconnects/second the capacity note plans for, 301 statements each is
 * ~100k statements/second; as one query it is 333.
 *
 * The `LATERAL` runs the same per-chat count the planner would have run anyway,
 * against the same `msg_ord` range — so this is the identical work with the
 * round trips removed, rather than a different algorithm.
 *
 * Access is by SPACE membership, the leading conjunct of the access predicate
 * (DESIGN.md §7.3). Phase 2 has no private chats, so that single join is the
 * whole predicate; Phase 5 adds the second conjunct here and nowhere else,
 * because nothing else decides what a client is told about.
 */
export async function welcome(
  db: Kysely<DB>, workspaceId: string, actorId: string,
): Promise<WelcomePayload> {
  // FOUR statements, and the number that matters is that it is FOUR rather than
  // four-plus-one-per-chat. The original chat query issued 1 + 2N — 301
  // statements for 150 chats — and reconnects arrive together after a deploy,
  // so an N+1 here multiplies by every client at once: at the ~333
  // reconnects/second §9.8 plans for, that was ~100k statements/second.
  //
  // A constant is not an N+1, so these run in parallel rather than being forced
  // into one query with `json_build_object`. The test asserts the count is
  // EQUAL at 150 chats and at 300, which is the property; asserting "one" would
  // have been asserting a number that happened to hold.
  const [chats, spaces, memberships, workspaceRev] = await Promise.all([
    welcomeChats(db, workspaceId, actorId),
    welcomeSpaces(db, actorId),
    welcomeMemberships(db, actorId),
    db.selectFrom('workspaces').select('next_rev')
      .where('id', '=', workspaceId).executeTakeFirst(),
  ]);

  return {
    spaces, chats, memberships,
    // Only the workspace stream. There is no actor cursor: an actor is a
    // delivery address rather than an ordered stream, so there is nothing to
    // be behind on (docs/SYNC-FLOWS.md §5). Space cursors ride on the space
    // rows themselves, above.
    streams: [{ kind: 'workspace', id: workspaceId, rev: workspaceRev?.next_rev ?? 0 }],
  };
}

/**
 * The spaces this actor has JOINED, with each one's stream cursor.
 *
 * Joined, not visible. A workspace with three hundred public channels where
 * this actor belongs to forty sends forty — public means discoverable, not
 * synced, and the difference is what keeps this frame sized by the person
 * rather than by the company (invariant 71).
 */
async function welcomeSpaces(db: Kysely<DB>, actorId: string): Promise<WelcomeSpace[]> {
  const rows = await db.selectFrom('spaces')
    .innerJoin('memberships', join => join
      .onRef('memberships.scope_id', '=', 'spaces.id')
      .on('memberships.scope_type', '=', 'space')
      .on('memberships.actor_id', '=', actorId)
      .on('memberships.left_at', 'is', null))
    .select(['spaces.id', 'spaces.kind', 'spaces.name', 'spaces.slug',
             'spaces.visibility', 'spaces.membership_policy', 'spaces.lifecycle',
             'spaces.next_rev'])
    .execute();

  return rows.map(row => ({
    id: row.id, kind: row.kind, name: row.name, slug: row.slug,
    visibility: row.visibility, membershipPolicy: row.membership_policy,
    lifecycle: row.lifecycle, rev: row.next_rev,
  }));
}

/**
 * The caller's OWN memberships — the grants `can()` evaluates for their own
 * affordances.
 *
 * Not everyone's. "Who else is in this space" is a view concern, answered per
 * space when a surface asks for it; sending every membership in the workspace
 * would be members × spaces in the worst case, which is precisely the shape
 * invariant 71 forbids.
 */
async function welcomeMemberships(
  db: Kysely<DB>, actorId: string,
): Promise<WelcomeMembership[]> {
  const rows = await db.selectFrom('memberships')
    .select(['scope_type', 'scope_id', 'role'])
    .where('actor_id', '=', actorId)
    .where('left_at', 'is', null)
    .execute();
  return rows.map(row => ({
    scopeType: row.scope_type, scopeId: row.scope_id, role: row.role,
  }));
}

async function welcomeChats(
  db: Kysely<DB>, workspaceId: string, actorId: string,
): Promise<WelcomeChat[]> {
  const rows = await db.selectFrom('chats')
    .innerJoin('memberships', join => join
      .onRef('memberships.scope_id', '=', 'chats.space_id')
      .on('memberships.scope_type', '=', 'space')
      .on('memberships.actor_id', '=', actorId)
      .on('memberships.left_at', 'is', null))
    // LEFT, so a chat the actor has never opened still appears. A missing row
    // means "never read", which is not the same fact as a row holding zero and
    // must not depend on one having been created at join time.
    .leftJoin('chat_read_state', join => join
      .onRef('chat_read_state.chat_id', '=', 'chats.id')
      .on('chat_read_state.actor_id', '=', actorId))
    .innerJoinLateral(
      eb => eb.selectFrom('messages')
        .select([
          eb.fn.countAll<number>().as('unread'),
          sql<number>`count(*) FILTER (WHERE messages.body LIKE ${mentionPattern(actorId)})`
            .as('mentions'),
        ])
        .whereRef('messages.chat_id', '=', 'chats.id')
        // COALESCE, not a default on the column: the left join above can
        // legitimately produce a null here.
        .where(sql<boolean>`messages.ord > COALESCE(chat_read_state.last_read_ord, 0)`)
        .where('messages.deleted', '=', false)
        .where('messages.author_id', '!=', actorId)
        // The same clause `counters` uses, so a badge cannot differ between
        // arriving in `welcome` and arriving in a later push.
        .where(visibleTo('messages', actorId))
        .as('counted'),
      join => join.onTrue())
    .select(['chats.id as chat_id', 'chats.space_id', 'chats.kind', 'chats.name',
             'chats.next_ord', 'chats.next_rev',
             'counted.unread', 'counted.mentions'])
    .where('chats.workspace_id', '=', workspaceId)
    .where('chats.kind', '!=', 'private')
    .execute();

  return rows.map(row => ({
    chatId: row.chat_id,
    spaceId: row.space_id,
    kind: row.kind,
    name: row.name,
    headOrd: row.next_ord,
    headRev: row.next_rev,
    chatUnread: row.unread,
    mentionCount: row.mentions,
  }));
}

const toMessage = (row: {
  id: string; ord: number; rev: number; author_id: string;
  body: string; parent_id: string | null; deleted: boolean;
  edited_at: Date | string | null; reply_count: number | string | null;
  visible_to: string[] | null;
  parts: unknown;
}): MessageRow => ({
  id: row.id, ord: row.ord, rev: row.rev, authorId: row.author_id,
  body: row.body, parentId: row.parent_id, deleted: row.deleted,
  editedAt: row.edited_at === null ? null
    : row.edited_at instanceof Date ? row.edited_at.toISOString() : String(row.edited_at),
  // A correlated COUNT comes back as a bigint string from node-postgres.
  replyCount: Number(row.reply_count ?? 0),
  visibleTo: row.visible_to,
  // JSONB arrives parsed. Anything but an array is not parts.
  parts: Array.isArray(row.parts) ? row.parts : null,
});

export interface DirectoryRow {
  id: string;
  type: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  ownerActorId: string | null;
  state: string;
  updatedAt: number;
  /** An agent's summary (WORKSPACE-AGENTS.md §4.5); absent for a person. */
  agent?: AgentSummary;
}

export interface DirectoryPage {
  rows: DirectoryRow[];
  nextAfterId: string | null;
  complete: boolean;
}

/** How many actors ride in one directory page. Four pages at 1,600 members. */
export const DIRECTORY_PAGE = 500;

/**
 * One page of the workspace directory, keyset on actor id.
 *
 * KEYSET, NEVER OFFSET, and actors have no ordinal to key on — but ULIDs sort,
 * so the primary key already gives a stable order. Offset paging would skip or
 * repeat rows when somebody joins mid-fetch, which for a directory means an
 * author silently missing from a client that paged past them.
 *
 * `identity_kind` and `identity_id` are deliberately not selected. They are
 * Layer 1 references (DESIGN.md §6.3), nothing on the client addresses an actor
 * by anything but `actor_id`, and sending them would hand every member a
 * directory of everyone else's external identifiers for no feature — which is
 * what the `identity/no-layer-1-on-the-client` boundary rule exists to catch.
 *
 * Deactivated actors ARE included. A tombstoned author still has to render on
 * the messages they wrote; dropping them shows an empty name where a greyed one
 * belongs.
 */
export async function directoryPage(
  db: Kysely<DB>, workspaceId: string,
  afterId: string | null = null, limit = DIRECTORY_PAGE,
): Promise<DirectoryPage> {
  let query = db.selectFrom('actors')
    .select(['id', 'type', 'handle', 'display_name', 'avatar_url',
             'owner_actor_id', 'state', 'updated_at'])
    .where('workspace_id', '=', workspaceId)
    .orderBy('id')
    .limit(limit);
  if (afterId !== null) query = query.where('id', '>', afterId);

  const rows = await query.execute();
  // Only the page's agents are looked up, in two statements whatever the page
  // holds; a page of people costs none.
  const summaries = await agentSummaries(db, rows.filter(r => r.type === 'agent').map(r => r.id));
  return {
    rows: rows.map(row => {
      const agent = summaries.get(row.id);
      return {
        id: row.id, type: row.type, handle: row.handle,
        displayName: row.display_name, avatarUrl: row.avatar_url,
        ownerActorId: row.owner_actor_id, state: row.state,
        updatedAt: new Date(row.updated_at as unknown as string).getTime(),
        ...(agent ? { agent } : {}),
      };
    }),
    // Derived from the page being short rather than asked for, so a client
    // cannot be told to keep paging into nothing.
    nextAfterId: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
    complete: rows.length < limit,
  };
}
