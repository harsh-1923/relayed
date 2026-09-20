// The ingest job: conversations that have finished become facts
// (docs/MEMORY.md §6, and the loop in §14.4).
//
// A JOB, NOT A RUN. Every agent run spends an invoker's authority — their
// permissions, their connections, their name on the result. A refresh has no
// invoker: nobody asked for it. So this is the shape `summariser.ts` already
// uses — claim work, do it, write the result — and it still acts AS AN ACTOR,
// the Roomkeeping agent, which is what makes the privacy rule need no special
// case. It is a member of the room, and the ordinary access predicate decides
// what it may read.
//
// POLLING IS CORRECT HERE, and not by inheritance. The trigger is QUIET — the
// absence of a message — and there is no event for a non-event. Nothing can
// push "this conversation has finished"; it can only be noticed.
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { env } from '../env.ts';
import { visibleTo } from '../sync/visibility.ts';
import { ROOMKEEPER_HANDLE } from '../provisioning/system-agents.ts';
import {
  bankForSpace, ensureBank, workspaceBank, MEMORY_MISSION, type SpacePlacement,
} from './banks.ts';
import { documentIdFor, recordDocument } from './documents.ts';
import { memoryConfigured, retain } from './client.ts';
import { forgetSweep } from './forget.ts';
import {
  buildEpisodeText, firstEpisode, readyToIngest, revMax, MAX_EPISODE, QUIET_MINUTES,
  type EpisodeMessage,
} from './episode.ts';

/** How long a claim is held. A lease in the past means the server that took it is gone. */
const LEASE_SEC = 300;
/** Chats one pass will ingest. The rest wait for the next tick rather than a long serial burn. */
const BATCH = 5;
/**
 * Episodes one pass will take from a single chat.
 *
 * One would be enough at steady state, and wrong the first time memory is
 * switched on for an existing room: months of history is hundreds of pending
 * episodes, and one a minute is hours of drain. Bounded so a chat with a
 * backlog cannot hold the lease all day while the others wait.
 */
const EPISODES_PER_PASS = 10;
const POLL_MS = 60_000;
/** Failures double the wait, to here. */
const BACKOFF_CEILING_SEC = 30 * 60;

export interface DueChat {
  chatId: string;
  spaceId: string;
  workspaceId: string;
  spaceName: string | null;
  /** For naming the workspace bank after the workspace, not after a room in it. */
  workspaceName: string | null;
  visibility: 'public' | 'private' | null;
  writerActorId: string;
  watermark: number;
}

/**
 * Chats with uningested messages, in a space memory may read.
 *
 * Every conjunct is a rule from §5.4 or §6.1 rather than an optimisation, and
 * they are here rather than in TypeScript so no caller can forget one:
 *
 *   · Roomkeeping must be an ACTIVE MEMBER of the space — its membership IS the
 *     privacy boundary, which is why there is no second rule about what may be
 *     read (Rule 1: no reader, no memory);
 *   · only `sole`, `default` and `public` chats — a room's PRIVATE chat is
 *     narrower than the room, and its facts would surface in the room's default
 *     chat where its members are not;
 *   · `lifecycle = 'active'` — a dormant or archived space keeps everything it
 *     has and accrues nothing;
 *   · the lease is free, so two servers cannot ingest one chat at once.
 *
 * Deleted and restricted messages are excluded where the episode is read
 * (`episodeFor`) rather than here, because this only needs to know whether
 * ANYTHING is pending.
 */
export async function dueChats(db: Kysely<DB>, limit = BATCH): Promise<DueChat[]> {
  const allowed = env.memoryIngestSpaces;
  const rows = await sql<{
    chat_id: string; space_id: string; workspace_id: string; space_name: string | null;
    workspace_name: string | null;
    visibility: 'public' | 'private' | null; writer_actor_id: string; watermark: number;
  }>`
    SELECT c.id            AS chat_id,
           c.space_id      AS space_id,
           c.workspace_id  AS workspace_id,
           s.name          AS space_name,
           ws.name         AS workspace_name,
           s.visibility    AS visibility,
           keeper.id       AS writer_actor_id,
           COALESCE(w.ingested_through_ord, 0) AS watermark
      FROM chats c
      JOIN spaces s ON s.id = c.space_id AND s.lifecycle = 'active'
      JOIN workspaces ws ON ws.id = c.workspace_id
      JOIN actors keeper
        ON keeper.workspace_id = c.workspace_id
       AND keeper.handle = ${ROOMKEEPER_HANDLE}
       AND keeper.provisioned_by = 'system'
       AND keeper.state = 'active'
      JOIN memberships mem
        ON mem.scope_type = 'space' AND mem.scope_id = s.id
       AND mem.actor_id = keeper.id AND mem.left_at IS NULL
      LEFT JOIN memory_watermarks w ON w.chat_id = c.id
     WHERE c.kind IN ('sole', 'default', 'public')
       AND (w.lease_until IS NULL OR w.lease_until < now())
       AND (w.failures IS NULL OR w.updated_at < now() - make_interval(secs =>
             LEAST(${BACKOFF_CEILING_SEC}, POWER(2, LEAST(w.failures, 10))::int)))
       AND ${allowed === null ? sql`TRUE` : sql`s.id = ANY(${allowed})`}
       AND EXISTS (SELECT 1 FROM messages m
                    WHERE m.chat_id = c.id
                      AND m.ord > COALESCE(w.ingested_through_ord, 0)
                      AND m.deleted = false)
     ORDER BY COALESCE(w.updated_at, to_timestamp(0))
     LIMIT ${limit}`.execute(db);

  return rows.rows.map((row) => ({
    chatId: row.chat_id, spaceId: row.space_id, workspaceId: row.workspace_id,
    spaceName: row.space_name, workspaceName: row.workspace_name, visibility: row.visibility,
    writerActorId: row.writer_actor_id, watermark: Number(row.watermark),
  }));
}

/**
 * Take the chat, or find somebody else already has it.
 *
 * A conditional upsert rather than a read-then-write: two servers polling the
 * same second both see it free, and only one may leave with it.
 */
export async function claimChat(db: Kysely<DB>, due: DueChat): Promise<boolean> {
  const claimed = await sql<{ chat_id: string }>`
    INSERT INTO memory_watermarks (chat_id, space_id, workspace_id, lease_until)
    VALUES (${due.chatId}, ${due.spaceId}, ${due.workspaceId},
            now() + make_interval(secs => ${LEASE_SEC}))
    ON CONFLICT (chat_id) DO UPDATE
       SET lease_until = EXCLUDED.lease_until
     WHERE memory_watermarks.lease_until IS NULL
        OR memory_watermarks.lease_until < now()
    RETURNING chat_id`.execute(db);
  return claimed.rows.length > 0;
}

/**
 * The messages after the watermark, as the writer may read them.
 *
 * `visibleTo(writer)` is the whole access check, and it is the same expression
 * every other reader uses. A restricted message the writer is not listed on is
 * simply absent, so §5.4's "never ingested" needs no rule of its own.
 */
export async function episodeFor(
  db: Kysely<DB>, due: DueChat,
): Promise<EpisodeMessage[]> {
  const rows = await db.selectFrom('messages as m')
    .innerJoin('actors as a', 'a.id', 'm.author_id')
    .select(['m.id', 'm.ord', 'm.rev', 'm.body', 'm.created_at', 'm.author_id',
             'a.display_name as author_display_name', 'a.handle as author_handle',
             'a.type as author_type'])
    .where('m.chat_id', '=', due.chatId)
    .where('m.ord', '>', due.watermark)
    .where('m.deleted', '=', false)
    // Authored conversation only. A system row — "Alice was added by Bob" — is
    // the server recording its own successful command, not something anyone
    // said, and memory is about what people decided rather than membership
    // bookkeeping. Found by reading a real recall, where "Triage added Harsh to
    // the room" ranked FIRST. Filtered on `message_kind`, which DESIGN.md §8.1a
    // insists is a real column precisely so nobody infers this from a shape.
    .where('m.message_kind', '=', 'actor')
    .where(visibleTo('m', due.writerActorId))
    .orderBy('m.ord')
    // One extra, so `firstEpisode` can see the gap that ends the episode rather
    // than mistaking the end of the page for the end of the conversation.
    .limit(MAX_EPISODE + 1)
    .execute();

  return rows.map((row) => ({
    id: row.id, ord: row.ord, rev: row.rev, body: row.body,
    createdAt: new Date(row.created_at as unknown as string),
    authorId: row.author_id, authorDisplayName: row.author_display_name,
    authorHandle: row.author_handle, authorType: row.author_type,
  }));
}

/** What this bank is, in the words a person reading the Hindsight console needs. */
const bankName = (due: DueChat): string =>
  bankForSpace({ id: due.spaceId, workspaceId: due.workspaceId, visibility: due.visibility })
    === workspaceBank(due.workspaceId)
    ? `${due.workspaceName ?? 'Workspace'} — shared rooms and channels`
    : due.spaceName ?? due.spaceId;

export type IngestOutcome =
  | { state: 'ingested'; documentId: string; messages: number; through: number }
  | { state: 'waiting' }
  | { state: 'failed'; reason: string };

/**
 * One episode from one chat.
 *
 * NOTHING IS FILTERED ON THE WAY IN. An episode of nothing but `lol` and `🎉`
 * is sent like any other, and Hindsight's extraction decides there is nothing
 * to remember. An earlier draft gated this locally; the arithmetic never
 * supported it — retain bills per input token, so a filter can only ever drop
 * SMALL episodes, which are the cheap ones, while risking the one real sentence
 * buried among the reactions.
 *
 * The order is load-bearing at two points. The INDEX ROW IS WRITTEN BEFORE THE
 * RETAIN (`recordDocument`): a row with no document costs a wasted delete, while
 * a document with no row can never be forgotten, moved or counted. And the
 * WATERMARK MOVES LAST, so any failure before it means the same episode is tried
 * again — with the same derived document id, which replaces rather than
 * duplicates.
 */
export async function ingestEpisode(db: Kysely<DB>, due: DueChat, now = new Date()): Promise<IngestOutcome> {
  const pending = await episodeFor(db, due);
  const episode = firstEpisode(pending);
  if (episode.length === 0) return { state: 'waiting' };
  if (!readyToIngest(episode, now)) return { state: 'waiting' };

  const through = episode.at(-1)!.ord;
  const space: SpacePlacement =
    { id: due.spaceId, workspaceId: due.workspaceId, visibility: due.visibility };
  const bankId = bankForSpace(space);
  const documentId = documentIdFor(due.chatId, episode[0]!.ord, through);

  try {
    // NAMED FOR WHAT THE BANK IS, not for whichever space happened to write to
    // it last. `ensureBank` applies the name every time, so passing the space
    // name unconditionally renamed the SHARED workspace bank after the most
    // recent public room — which made the Hindsight console show one room's
    // name over facts from several, and told extraction the bank belonged to a
    // room when it does not (§6.3, where the bank's identity steers what a fact
    // is filed as).
    await ensureBank(bankId, bankName(due));
    await recordDocument(db, {
      bankId, documentId, workspaceId: due.workspaceId, spaceId: due.spaceId,
      chatId: due.chatId, ordStart: episode[0]!.ord, ordEnd: through,
      sourceRevMax: revMax(episode),
    });
    await retain({
      bankId,
      content: buildEpisodeText(episode),
      // Extraction decides `world` versus `experience` BY WHO IS SPEAKING, and
      // assumes a bank belongs to an agent. A space bank has no agent, so
      // without this the room's conversation is filed as the lived experience
      // of an assistant that does not exist (§6.3).
      context: `A conversation in ${due.spaceName ?? 'a room'}. The speakers are people and ` +
               'agents working in this room. None of them is the owner of this memory bank.',
      documentId,
      timestamp: episode[0]!.createdAt.toISOString(),
      tags: [`space:${due.spaceId}`, `chat:${due.chatId}`],
      metadata: { space_id: due.spaceId, chat_id: due.chatId },
    });
  } catch (error) {
    await recordFailure(db, due.chatId);
    return { state: 'failed', reason: (error as Error).message };
  }

  await advanceWatermark(db, due.chatId, through);
  return { state: 'ingested', documentId, messages: episode.length, through };
}

/**
 * Every episode a chat has pending, up to the per-pass bound.
 *
 * A chat that talked at 09:00 and again at 14:00 holds two episodes, and they
 * go as two separate retains — never merged, because extraction asked to relate
 * two unrelated conversations will find a relation. They simply go in the same
 * pass rather than a minute apart.
 */
export async function ingestChat(db: Kysely<DB>, due: DueChat, now = new Date()): Promise<IngestOutcome[]> {
  const outcomes: IngestOutcome[] = [];
  let watermark = due.watermark;
  for (let taken = 0; taken < EPISODES_PER_PASS; taken++) {
    const outcome = await ingestEpisode(db, { ...due, watermark }, now);
    if (outcome.state !== 'ingested') {
      // `waiting` on the first look means nothing is ready; after one or more
      // episodes it means the backlog is drained. Either way there is no more
      // to take, and only a real failure is worth reporting on its own.
      if (outcome.state === 'failed' || taken === 0) outcomes.push(outcome);
      break;
    }
    outcomes.push(outcome);
    watermark = outcome.through;
  }
  return outcomes;
}

/** Everything at or below `ord` has been sent. Extraction decides what became a fact. */
export async function advanceWatermark(db: Kysely<DB>, chatId: string, ord: number): Promise<void> {
  // `now()` rather than a JS Date: server time is authoritative for anything
  // cross-process, and two servers with skewed clocks would otherwise take
  // turns winding the backoff window backwards (DESIGN.md §13.7).
  await sql`UPDATE memory_watermarks
               SET ingested_through_ord = ${ord}, lease_until = NULL,
                   failures = 0, updated_at = now()
             WHERE chat_id = ${chatId}`.execute(db);
}

/** Keep the watermark; drop the lease; let the backoff widen. */
async function recordFailure(db: Kysely<DB>, chatId: string): Promise<void> {
  await sql`UPDATE memory_watermarks
               SET failures = failures + 1, lease_until = NULL, updated_at = now()
             WHERE chat_id = ${chatId}`.execute(db);
}

/** One pass. Returns what it did, so a script can print it and a test can assert it. */
export async function ingestOnce(db: Kysely<DB>, limit = BATCH): Promise<IngestOutcome[]> {
  if (!env.memoryIngest || !memoryConfigured()) return [];
  const outcomes: IngestOutcome[] = [];
  for (const due of await dueChats(db, limit)) {
    if (!await claimChat(db, due)) continue;
    outcomes.push(...await ingestChat(db, due));
  }
  return outcomes;
}

export interface Ingest { stop(): void }

/**
 * The ticker.
 *
 * Off unless `MEMORY_INGEST=1` and Hindsight is configured, and it says which
 * it was missing rather than starting silently — a server that quietly declines
 * to build memory looks exactly like one where extraction is producing nothing.
 */
export function startIngest(db: Kysely<DB>): Ingest {
  const missing = [
    ...(env.memoryIngest ? [] : ['MEMORY_INGEST=1']),
    ...(memoryConfigured() ? [] : ['HINDSIGHT_BASE_URL', 'HINDSIGHT_API_KEY']),
  ];
  if (missing.length > 0) {
    console.log(JSON.stringify({ event: 'memory.ingest.not_started', missing }));
    return { stop() {} };
  }
  console.log(JSON.stringify({
    event: 'memory.ingest.started',
    quiet_minutes: QUIET_MINUTES, max_episode: MAX_EPISODE,
    spaces: env.memoryIngestSpaces?.length ?? 'all',
    mission_bytes: MEMORY_MISSION.length,
  }));

  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await ingestOnce(db);
      // The sweep rides the same tick. Forgetting has to keep up with
      // ingesting, and a second timer would be a second thing to reason about
      // for no gain (MEMORY.md §14.4).
      await forgetSweep(db);
    }
    catch (error) { console.error(JSON.stringify({ event: 'memory.ingest.tick_failed', code: (error as Error).name })); }
    if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
  };
  let timer = setTimeout(() => void tick(), POLL_MS);
  return { stop() { stopped = true; clearTimeout(timer); } };
}
