// The read path's domain layer: head state, catch-up, gaps, backfill, counters
// and the `welcome` payload. Phase 2 step C (PHASE-2-SYNC.md §3).
//
// Ported from `spikes/sync-model.mjs`, which is the acceptance suite rather
// than a sketch. Ported, not transliterated: three of its statements are
// correct only because it runs one single-threaded in-memory SQLite connection
// or uses SQLite spellings, and each is named where it changed.
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { chatStream, type Stream } from './events.ts';

/** How far behind a client may be before catch-up becomes a gap marker. */
export const GAP_THRESHOLD = 500;

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

export interface MessageRow {
  id: string;
  ord: number;
  rev: number;
  authorId: string;
  body: string;
  parentId: string | null;
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

export type Catchup =
  | { kind: 'replay'; chatId: string; fromRev: number; toRev: number; events: Event[] }
  | { kind: 'gap'; chatId: string; headRev: number; headOrd: number; recent: MessageRow[] };

/** The last allocated ordinal and revision. Zero on a chat nothing has touched. */
export async function head(db: Kysely<DB>, chatId: string): Promise<Head> {
  const row = await db.selectFrom('chats').select(['next_ord', 'next_rev'])
    .where('id', '=', chatId).executeTakeFirst();
  return { headOrd: row?.next_ord ?? 0, headRev: row?.next_rev ?? 0 };
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
  db: Kysely<DB>, stream: Stream, fromRev: number, limit = GAP_THRESHOLD,
): Promise<Event[]> {
  const rows = await db.selectFrom('sync_events')
    .select(['stream_rev', 'event_type', 'payload'])
    .where('stream_kind', '=', stream.kind)
    .where('stream_id', '=', stream.id)
    .where('stream_rev', '>', fromRev)
    // An exact prefix seek on the unique index, which is why there is no second
    // index on these columns (008_sync_events.sql).
    .orderBy('stream_rev')
    .limit(limit)
    .execute();

  return rows.map((row): Event =>
    ({ rev: row.stream_rev, type: row.event_type, payload: row.payload }));
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
 */
export async function catchup(
  db: Kysely<DB>, chatId: string, fromRev: number, threshold = GAP_THRESHOLD,
): Promise<Catchup> {
  const { headRev, headOrd } = await head(db, chatId);

  if (headRev - fromRev > threshold) {
    const rows = await db.selectFrom('messages')
      .select(['id', 'ord', 'rev', 'author_id', 'body', 'parent_id'])
      .where('chat_id', '=', chatId)
      .where('deleted', '=', false)
      .orderBy('ord', 'desc')
      .limit(GAP_TAIL)
      .execute();
    return {
      kind: 'gap', chatId, headRev, headOrd,
      // Newest-first from the database, oldest-first to the client: it renders
      // in ordinal order, and reversing here means every caller does not.
      recent: rows.reverse().map(toMessage),
    };
  }

  const events = await eventsSince(db, chatStream(chatId), fromRev);

  // `toRev` is what the client's frontier BECOMES once this batch applies, so
  // it is derived from what was actually delivered — never from the head.
  //
  // Those are the same number today only because the replay threshold and
  // `eventsSince`'s limit happen to be the same constant. They are two
  // constants, and step 9 of the plan exists partly to retune the first with
  // real traffic (docs/SYNC-FLOWS.md §2). Tune it upward against a fixed limit
  // and `toRev: headRev` would tell a client its frontier had reached the head
  // when only the first 500 events were sent — advancing it past events it
  // never received, which is a silent permanent hole and the exact failure the
  // contiguity rule exists to prevent (invariant 1).
  //
  // Empty falls back to `fromRev`, not `headRev`: nothing arrived, so nothing
  // moves.
  const toRev = events.length > 0 ? (events.at(-1) as Event).rev : fromRev;

  return { kind: 'replay', chatId, fromRev, toRev, events };
}

/**
 * One page of history below an ordinal, newest first.
 *
 * Keyset on `ord`, never OFFSET: offset paging degrades linearly and, worse,
 * skips or repeats rows when anything is inserted mid-scroll (DESIGN.md §11.3).
 *
 * Tombstones are excluded and thread replies are excluded — the chat view is
 * top-level messages, and the partial index `msg_chat_view` is what stops a
 * thread with 800 replies being scanned to find 50 chat messages.
 */
export async function backfill(
  db: Kysely<DB>, chatId: string, beforeOrd: number, limit = 50,
): Promise<MessageRow[]> {
  const rows = await db.selectFrom('messages')
    .select(['id', 'ord', 'rev', 'author_id', 'body', 'parent_id'])
    .where('chat_id', '=', chatId)
    .where('deleted', '=', false)
    .where('parent_id', 'is', null)
    .where('ord', '<', beforeOrd)
    .orderBy('ord', 'desc')
    .limit(limit)
    .execute();
  return rows.map(toMessage);
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
 * Both exclusions matter. Your own messages are not unread to you, and a
 * tombstone is not unread to anyone — which is also why the arithmetic fallback
 * `headOrd - lastReadOrd` can only ever be a sanity check: it cannot see either.
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
 * Mentions are `<@actor_id>` markup, never a handle — a rename would otherwise
 * orphan every historical mention (PHASE-1-IDENTITY.md §10). The spike matched
 * `@actorId`, which is its own fixtures' shape rather than the product's.
 *
 * Defined once because two paths count mentions, and a pattern that differed
 * between them would make a badge disagree with itself depending on whether it
 * arrived in `welcome` or in a later `counters` push.
 */
const mentionPattern = (actorId: string): string => `%<@${actorId}>%`;

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
  body: string; parent_id: string | null;
}): MessageRow => ({
  id: row.id, ord: row.ord, rev: row.rev, authorId: row.author_id,
  body: row.body, parentId: row.parent_id,
});
