// Asking for what was missed, and rendering while behind.
// Step 9 of the sync build plan (docs/SYNC-FLOWS.md §2, §12–§14).
//
// THREE DIFFERENT QUESTIONS, and conflating any two of them is how this goes
// wrong:
//
//   catch-up   "what CHANGED after my frontier?"   keyed by REVISION
//   gap        "I am too far behind to replay"     current state, not history
//   backfill   "give me history below this point"  keyed by ORDINAL
//
// Catch-up replays what happened; backfill hydrates what a partial replica
// chose not to hold. Ask backfill for a replay and a client re-renders a
// thousand deletions to draw a scrollback.
import type { DatabaseSync } from 'node:sqlite';
import { applyBatch, behind, type ApplyDeps, type Stream, type Envelope } from './apply.ts';
import { observe } from './observe.ts';

/**
 * One catch-up request in flight per stream, and one queued behind it.
 *
 * A COALESCED REQUEST, not one per hole. A client that fell behind by a hundred
 * events sees a hundred staged arrivals; asking each time would send a hundred
 * requests for one answer, and the answer to all of them is the same range.
 *
 * The queued bit matters as much as the in-flight bit: an event that arrives
 * while a request is out means the reply will already be stale, so exactly one
 * follow-up is remembered — not zero, which leaves the client behind for ever,
 * and not a queue, which is the same storm with a delay.
 */
export class CatchupScheduler {
  #inflight = new Set<string>();
  #again = new Set<string>();
  #request: (stream: Stream, fromRev: number) => void;
  #db: DatabaseSync;
  /**
   * Streams whose catch-up reply landed since the last sweep.
   *
   * The other half of the definition, and the half that took a correction. The
   * first version asked whether a request was outstanding — but `settled`
   * immediately re-asks while a stream is still behind, so a struggling stream
   * is ALWAYS outstanding and the signal could essentially never fire. What
   * makes a stall unambiguous is that we asked, we were ANSWERED, and the
   * frontier is still exactly where it was.
   */
  #answered = new Set<string>();

  constructor(db: DatabaseSync, request: (stream: Stream, fromRev: number) => void) {
    this.#db = db;
    this.#request = request;
  }

  /** Ask for everything currently owed. Safe to call as often as you like. */
  sweep(): void {
    const owing = behind(this.#db);
    let worstLag = 0;

    for (const owed of owing) {
      const key = keyOf(owed.stream);
      const lag = owed.to - owed.from;
      worstLag = Math.max(worstLag, lag);

      // BEHIND IS NOT STALLED. A client returning from a week offline is a
      // hundred thousand revisions behind and perfectly healthy — that is what
      // catch-up is FOR, and a signal that fired on it would fire on the most
      // ordinary event there is. Stalled is: behind at the last sweep, behind
      // now, a reply came back in between, and the frontier is exactly where it
      // was. That is a hole nothing is going to fill, and it is completely
      // silent — no error, no spinner, just a client that has quietly stopped
      // receiving messages.
      const previous = sweptAt(this.#db, owed.stream);
      if (previous !== null && previous === owed.from && this.#answered.has(key)) {
        observe('sync.cursor.stalled', {
          stream: owed.stream.kind, id: owed.stream.id,
          cursor_rev: owed.from, head_rev: owed.to, lag,
        });
      }
      markSwept(this.#db, owed.stream, owed.from);
      this.#answered.delete(key);
      this.want(owed.stream);
    }

    // A stream that caught up forgets its mark, or it would compare against a
    // frontier from before it did and read as stalled the next time it fell
    // behind by one event.
    clearSweptForCaughtUp(this.#db);

    // The pair invariant 1 is measured by, sampled per sweep rather than per
    // event: how far behind the worst stream is, and how much is being held
    // out of order waiting for a revision that may never arrive.
    observe('sync.frontier', { lag: worstLag, staged: stagedDepth(this.#db) });
  }

  /** Ask for one stream, or remember to ask again if a request is already out. */
  want(stream: Stream): void {
    const key = keyOf(stream);
    if (this.#inflight.has(key)) { this.#again.add(key); return; }
    this.#inflight.add(key);
    this.#request(stream, frontier(this.#db, stream));
  }

  /**
   * A reply landed. Ask again if the stream is still behind.
   *
   * Driven by the DATABASE rather than by what the reply said, because the two
   * can differ: a live event may have arrived and staged while the request was
   * out, and a truncated batch leaves the stream behind by construction.
   */
  settled(stream: Stream): void {
    const key = keyOf(stream);
    this.#answered.add(key);
    this.#inflight.delete(key);
    const wanted = this.#again.delete(key);
    if (wanted || stillBehind(this.#db, stream)) this.want(stream);
  }

  /** In-flight requests. A metric, and what a test asserts coalescing with. */
  get pending(): number { return this.#inflight.size; }
}

const keyOf = (stream: Stream): string => `${stream.kind}:${stream.id}`;

const frontier = (db: DatabaseSync, stream: Stream): number =>
  (db.prepare(`SELECT synced_through_rev FROM stream_state
               WHERE stream_kind = ? AND stream_id = ?`)
    .get(stream.kind, stream.id) as { synced_through_rev: number } | undefined)
    ?.synced_through_rev ?? 0;

const stillBehind = (db: DatabaseSync, stream: Stream): boolean =>
  behind(db).some(owed => keyOf(owed.stream) === keyOf(stream));

/**
 * Events held out of order, across every stream.
 *
 * Expected at or near zero: staged events collapse the moment the revision
 * before them lands, so a depth that never falls is the other face of a stalled
 * cursor — the events arrived, and the one thing needed to apply them did not.
 */
/** Where this stream's frontier stood at the previous sweep. Null if never. */
const sweptAt = (db: DatabaseSync, stream: Stream): number | null =>
  (db.prepare(`SELECT swept_at_rev FROM stream_state
               WHERE stream_kind = ? AND stream_id = ?`)
    .get(stream.kind, stream.id) as { swept_at_rev: number | null } | undefined)
    ?.swept_at_rev ?? null;

const markSwept = (db: DatabaseSync, stream: Stream, rev: number): void => {
  db.prepare(`UPDATE stream_state SET swept_at_rev = ?
               WHERE stream_kind = ? AND stream_id = ?`)
    .run(rev, stream.kind, stream.id);
};

/** Level streams forget their mark, so catching up cannot look like a stall. */
const clearSweptForCaughtUp = (db: DatabaseSync): void => {
  db.prepare(`UPDATE stream_state SET swept_at_rev = NULL
               WHERE swept_at_rev IS NOT NULL AND server_head_rev <= synced_through_rev`)
    .run();
};

const stagedDepth = (db: DatabaseSync): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM staged_events').get() as { n: number }).n;

/**
 * Apply a catch-up reply, in bounded chunks.
 *
 * CHUNKED AND YIELDING, which is not an optimisation. WAL lets readers proceed
 * during writes, but a single transaction holding the writer for fifty thousand
 * events blocks every other write and makes the queries a visible surface is
 * making wait behind it. The user's experience of "catching up" should be a
 * sidebar filling in, not an application that stops answering.
 */
export async function applyCatchup(
  deps: ApplyDeps, stream: Stream, events: readonly Envelope[], chunk = 200,
): Promise<{ topics: string[]; needsCatchup: boolean }> {
  const topics = new Set<string>();
  let needsCatchup = false;

  for (let at = 0; at < events.length; at += chunk) {
    const batch = applyBatch(deps, stream, events.slice(at, at + chunk));
    for (const t of batch.topics) topics.add(t);
    if (batch.needsCatchup) needsCatchup = true;
    // Between chunks, not inside one. Yielding mid-transaction would hold the
    // writer across a turn of the event loop, which is the opposite of the point.
    if (at + chunk < events.length) await new Promise(resolve => setImmediate(resolve));
  }

  return { topics: [...topics], needsCatchup };
}

export interface MessageRow {
  id: string;
  ord: number;
  rev: number;
  author_id: string;
  body: string;
  parent_id: string | null;
}

/**
 * Take a gap: adopt current state and jump the frontier past history never seen.
 *
 * THIS IS WHAT BOUNDS A RECONNECT TO O(STREAMS) rather than O(messages). A
 * person away for a week across 150 chats gets one small frame each, not a
 * hundred thousand messages.
 *
 * Jumping the frontier is safe precisely BECAUSE the tail is current state
 * rather than partial history. What sits below it is not missing-and-unknown,
 * it is missing-and-MARKED: `has_gap` says there is a floor and
 * `oldest_local_ord` says where, so backfill can repair it on demand and the UI
 * can say "there is more above" rather than pretending the chat starts here.
 */
export function applyGap(
  db: DatabaseSync, stream: Stream, headRev: number,
  snapshot: { kind: string; head_ord?: number; recent?: MessageRow[] },
): string[] {
  db.exec('BEGIN');
  try {
    let oldest: number | null = null;

    if (snapshot.kind === 'messages' && snapshot.recent) {
      const insert = db.prepare(`
        INSERT INTO messages (id, chat_id, parent_id, ord, rev, author_id, body,
                              created_at, state, local_only)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'acked', 0)
        ON CONFLICT(id) DO UPDATE SET
          ord = excluded.ord, rev = excluded.rev, body = excluded.body
      `);
      for (const row of snapshot.recent) {
        insert.run(row.id, stream.id, row.parent_id, row.ord, row.rev,
                   row.author_id, row.body);
        oldest = oldest === null ? row.ord : Math.min(oldest, row.ord);
      }
      db.prepare(`
        INSERT INTO chat_state (chat_id, head_ord, oldest_local_ord)
        VALUES (?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          head_ord = MAX(chat_state.head_ord, excluded.head_ord),
          -- The FLOOR, so it only ever goes down. A later gap with a shorter
          -- tail must not raise it and hide history already held.
          oldest_local_ord = MIN(
            COALESCE(chat_state.oldest_local_ord, excluded.oldest_local_ord),
            excluded.oldest_local_ord)
      `).run(stream.id, snapshot.head_ord ?? 0, oldest);
    }

    db.prepare(`
      INSERT INTO stream_state (stream_kind, stream_id, synced_through_rev,
                                server_head_rev, has_gap)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(stream_kind, stream_id) DO UPDATE SET
        synced_through_rev = excluded.synced_through_rev,
        server_head_rev = MAX(stream_state.server_head_rev, excluded.server_head_rev),
        has_gap = 1
    `).run(stream.kind, stream.id, headRev, headRev);

    // Everything staged is now below the frontier, so it can never be drained.
    // Left behind it would sit there for ever — the table's whole claim is that
    // it collapses to empty whenever the client is caught up.
    db.prepare('DELETE FROM staged_events WHERE stream_kind = ? AND stream_id = ?')
      .run(stream.kind, stream.id);

    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return stream.kind === 'chat'
    ? [`chat:${stream.id}:messages`, `chat:${stream.id}:state`]
    : [`${stream.kind}:${stream.id}`];
}

/**
 * Insert a page of history and lower the floor.
 *
 * LAZY, and on open rather than on reconnect: a chat nobody is looking at does
 * not need its scrollback, and fetching one for every gapped chat at reconnect
 * would undo exactly the bound the gap bought.
 */
export function applyBackfill(
  db: DatabaseSync, chatId: string, rows: readonly MessageRow[], complete: boolean,
): string[] {
  if (rows.length === 0 && !complete) return [];

  const started = performance.now();
  db.exec('BEGIN');
  try {
    const insert = db.prepare(`
      INSERT INTO messages (id, chat_id, parent_id, ord, rev, author_id, body,
                            created_at, state, local_only)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'acked', 0)
      ON CONFLICT(id) DO UPDATE SET
        ord = excluded.ord, rev = excluded.rev, body = excluded.body
    `);
    let oldest: number | null = null;
    for (const row of rows) {
      insert.run(row.id, chatId, row.parent_id, row.ord, row.rev,
                 row.author_id, row.body);
      oldest = oldest === null ? row.ord : Math.min(oldest, row.ord);
    }

    if (oldest !== null) {
      db.prepare(`UPDATE chat_state SET oldest_local_ord = MIN(
                    COALESCE(oldest_local_ord, ?), ?) WHERE chat_id = ?`)
        .run(oldest, oldest, chatId);
    }

    // The gap CLOSES when the floor reaches the beginning — either the server
    // said this was the last page, or we are holding ordinal 1. Clearing it on
    // "no rows returned" alone would clear it on a network hiccup too.
    const floor = (db.prepare('SELECT oldest_local_ord FROM chat_state WHERE chat_id = ?')
      .get(chatId) as { oldest_local_ord: number | null } | undefined)?.oldest_local_ord;
    if (complete || floor === 1) {
      db.prepare(`UPDATE stream_state SET has_gap = 0
                   WHERE stream_kind = 'chat' AND stream_id = ?`).run(chatId);
    }

    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  // Counted per PAGE, which is the unit somebody scrolling actually produces.
  // Read against `sync.gap` it answers what a gap costs: a gap nobody scrolls
  // back through is free, and one everybody does is not.
  observe('sync.backfill.page', {
    chat_id: chatId, rows: rows.length,
    duration: Math.round(performance.now() - started),
  });
  return [`chat:${chatId}:messages`];
}

/** Where a chat's scrollback currently stops, and whether more is known to exist. */
export function backfillFloor(
  db: DatabaseSync, chatId: string,
): { oldestLocalOrd: number | null; hasGap: boolean } {
  const state = db.prepare('SELECT oldest_local_ord FROM chat_state WHERE chat_id = ?')
    .get(chatId) as { oldest_local_ord: number | null } | undefined;
  const stream = db.prepare(`SELECT has_gap FROM stream_state
                              WHERE stream_kind = 'chat' AND stream_id = ?`)
    .get(chatId) as { has_gap: number } | undefined;
  return {
    oldestLocalOrd: state?.oldest_local_ord ?? null,
    hasGap: (stream?.has_gap ?? 0) === 1,
  };
}

export interface DirectoryRow {
  id: string;
  type: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  owner_actor_id: string | null;
  state: string;
  updated_at: number;
}

/**
 * Apply one page of the directory snapshot.
 *
 * PAGES ARE ADDITIVE, and the last one does NOT delete what it did not contain.
 * That is the difference from the HTTP directory this replaced, which was a
 * whole snapshot in one response and could therefore treat absence as removal.
 * A page cannot: an actor missing from page two is on page one.
 *
 * Removal is not something the directory needs to express anyway. An actor is
 * tombstoned rather than deleted, so leaving is an `actor.updated` carrying
 * `state: 'deactivated'` — and their row has to survive regardless, because
 * their past messages still have to render (DESIGN.md §6.3).
 */
export function applyDirectoryPage(
  db: DatabaseSync, workspaceId: string, rows: readonly DirectoryRow[],
): string[] {
  if (rows.length === 0) return [];

  db.exec('BEGIN');
  try {
    const upsert = db.prepare(`
      INSERT INTO actors (id, workspace_id, type, handle, display_name,
                          avatar_url, owner_actor_id, state, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type, handle = excluded.handle,
        display_name = excluded.display_name, avatar_url = excluded.avatar_url,
        owner_actor_id = excluded.owner_actor_id, state = excluded.state,
        updated_at = excluded.updated_at,
        -- The bytes we hold are the OLD url's. Keep the pointer only while the
        -- url is unchanged, or a rename of somebody's picture renders the
        -- previous one for ever.
        avatar_blob = CASE
          WHEN actors.avatar_url IS NOT DISTINCT FROM excluded.avatar_url
          THEN actors.avatar_blob ELSE NULL END
    `);
    for (const row of rows) {
      upsert.run(row.id, workspaceId, row.type, row.handle, row.display_name,
                 row.avatar_url, row.owner_actor_id, row.state, row.updated_at);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return ['actors'];
}

/**
 * Adopt the cursor a completed snapshot corresponds to.
 *
 * Called ONLY after the last page. The same trade the gap makes, and safe for
 * the same reason: what has been adopted is current state for the whole
 * workspace, so the revisions between the old cursor and this head describe
 * changes already reflected in the rows.
 *
 * Called after page one instead, a client would believe it held a directory it
 * had only started fetching — and every actor on pages two onwards would be
 * missing until somebody happened to change.
 */
export function directorySnapshotComplete(
  db: DatabaseSync, workspaceId: string, headRev: number,
): void {
  db.prepare(`
    INSERT INTO stream_state (stream_kind, stream_id, synced_through_rev,
                              server_head_rev, has_gap)
    VALUES ('workspace', ?, ?, ?, 0)
    ON CONFLICT(stream_kind, stream_id) DO UPDATE SET
      synced_through_rev = MAX(stream_state.synced_through_rev, excluded.synced_through_rev),
      server_head_rev = MAX(stream_state.server_head_rev, excluded.server_head_rev),
      has_gap = 0
  `).run(workspaceId, headRev, headRev);
}

/** Does this client still owe itself a directory fetch? */
export function directoryOwed(db: DatabaseSync, workspaceId: string): boolean {
  const row = db.prepare(`SELECT synced_through_rev, has_gap FROM stream_state
                           WHERE stream_kind = 'workspace' AND stream_id = ?`)
    .get(workspaceId) as { synced_through_rev: number; has_gap: number } | undefined;
  // Never heard of, or gapped. A fresh device has no row at all, which is the
  // same fact as a cursor of zero and is treated as one.
  return !row || row.has_gap === 1 || row.synced_through_rev === 0;
}
