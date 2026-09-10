// The read path's domain layer: head state, catch-up, gaps, backfill, counters
// and the `welcome` payload. Phase 2 step C (PHASE-2-SYNC.md §3).
//
// Ported from `spikes/sync-model.mjs`, which is the acceptance suite rather
// than a sketch. Ported, not transliterated: three of its statements are
// correct only because it runs one single-threaded in-memory SQLite connection
// or uses SQLite spellings, and each is named where it changed.
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';

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

export type Event =
  | { rev: number; op: 'msg'; message: MessageRow }
  | { rev: number; op: 'del'; messageId: string };

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
 * Every change with `rev > fromRev`, in revision order.
 *
 * One stream carrying both new messages and deletes, which is the whole reason
 * `rev` exists apart from `ord`: catch-up is uniform, so a client asks one
 * question per chat rather than one per kind of change (DESIGN.md §8.1).
 *
 * A delete is recognised by its `deleted` flag rather than by a separate table.
 * The spike also distinguished 'edit' by a null ordinal; edits are Phase 4 and
 * that branch is deliberately absent rather than carried unexercised.
 */
export async function eventsSince(
  db: Kysely<DB>, chatId: string, fromRev: number,
): Promise<Event[]> {
  const rows = await db.selectFrom('messages')
    .select(['id', 'ord', 'rev', 'author_id', 'body', 'deleted', 'parent_id'])
    .where('chat_id', '=', chatId)
    .where('rev', '>', fromRev)
    .orderBy('rev')
    .execute();

  return rows.map((row): Event => row.deleted
    ? { rev: row.rev, op: 'del', messageId: row.id }
    : { rev: row.rev, op: 'msg', message: {
        id: row.id, ord: row.ord, rev: row.rev, authorId: row.author_id,
        body: row.body, parentId: row.parent_id } });
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

  return { kind: 'replay', chatId, fromRev, toRev: headRev,
           events: await eventsSince(db, chatId, fromRev) };
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
    .select(['chats.id as chat_id', 'chats.next_ord', 'chats.next_rev',
             'counted.unread', 'counted.mentions'])
    .where('chats.workspace_id', '=', workspaceId)
    .where('chats.kind', '!=', 'private')
    .execute();

  return rows.map(row => ({
    chatId: row.chat_id,
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
