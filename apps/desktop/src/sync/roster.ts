// Who is in a space, held on this device (SPACE-MEMBERSHIP-MARKERS.md, rosters).
//
// The directory's shape, one space at a time: a paged snapshot, fetched once,
// then kept current by the membership events on the space's own stream. A
// reconnect replays those events from the space's cursor like any other, so a
// list is fetched again only after a gap — never on every connect.
//
// WHICH LISTS ARE FETCHED. Rooms and group messages are small and read often
// (pickers, member lists), so they are fetched as soon as `welcome` lands. A
// channel is too, up to EAGER_ROSTER_LIMIT members; a larger one only when a
// surface asks for it — after which it is held and kept current like the rest.
// A DM needs none: who it is between is on its row.
import type { DatabaseSync } from 'node:sqlite';
import type { RosterOk } from '@relayed/protocol';
import { topic } from '../shared/topics.ts';
import type { SpaceRoster } from '../shared/spaces.ts';

export const EAGER_ROSTER_LIMIT = 200;
/** Spaces asked about in one request; the protocol's own ceiling. */
export const ROSTER_BATCH = 50;

/**
 * The lists this device should fetch now: every one left `loading` — by a
 * connection that dropped mid-fetch, a gap, or a surface that asked — and every
 * eager space never fetched. Only spaces this person is still in: the replica's
 * `memberships` holds their own rows alone, replaced on every `welcome`.
 */
export function rostersOwed(db: DatabaseSync): string[] {
  return (db.prepare(`
    SELECT s.id FROM spaces s
      JOIN memberships m ON m.scope_type = 'space' AND m.scope_id = s.id AND m.left_at IS NULL
      LEFT JOIN space_rosters r ON r.space_id = s.id
     WHERE r.state = 'loading'
        OR (r.space_id IS NULL AND (
              s.kind IN ('room', 'group_dm')
           OR (s.kind = 'channel' AND s.member_count IS NOT NULL AND s.member_count <= ?)))
     ORDER BY s.id
  `).all(EAGER_ROSTER_LIMIT) as { id: string }[]).map(row => row.id);
}

/**
 * A surface wants this list. Marks it owed, and says whether it was not
 * already: the caller then starts the fetch. A space this person is not in is
 * left alone — the server would refuse it.
 */
export function wantRoster(db: DatabaseSync, spaceId: string): boolean {
  const joined = db.prepare(`SELECT 1 FROM memberships
                              WHERE scope_type = 'space' AND scope_id = ? AND left_at IS NULL`).get(spaceId);
  if (!joined) return false;
  const inserted = db.prepare(`INSERT INTO space_rosters (space_id, state) VALUES (?, 'loading')
                                ON CONFLICT(space_id) DO NOTHING`).run(spaceId);
  return Number(inserted.changes) > 0;
}

/**
 * Fetch this list again: after a gap on its stream, whose membership events
 * this device will now never see. Only a list already held — one never
 * fetched is not owed by a gap.
 */
export function refetchRoster(db: DatabaseSync, spaceId: string): string[] {
  const changed = db.prepare(`UPDATE space_rosters SET state = 'loading', dirty = 0
                               WHERE space_id = ?`).run(spaceId);
  if (Number(changed.changes) === 0) return [];
  db.prepare('DELETE FROM space_members WHERE space_id = ?').run(spaceId);
  return [topic.spaceMembers(spaceId)];
}

/**
 * Start fetching these lists. Whatever was held is forgotten first, so a list
 * is never a mix of two snapshots.
 */
export function beginRosters(db: DatabaseSync, spaceIds: readonly string[]): string[] {
  db.exec('BEGIN');
  try {
    const clear = db.prepare('DELETE FROM space_members WHERE space_id = ?');
    const mark = db.prepare(`INSERT INTO space_rosters (space_id, state, dirty) VALUES (?, 'loading', 0)
                              ON CONFLICT(space_id) DO UPDATE SET state = 'loading', dirty = 0`);
    for (const id of spaceIds) { clear.run(id); mark.run(id); }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return spaceIds.map(id => topic.spaceMembers(id));
}

export interface RosterPageResult {
  topics: string[];
  /** Lists that finished while a membership event landed, and must be fetched again. */
  again: string[];
}

/**
 * One page, for the spaces `asked` names.
 *
 * A space the server left out of `space_ids` was refused — this person is no
 * longer in it — and is dropped rather than asked about again. A space is
 * finished once the page has moved past it. A finished list that took a
 * membership event while loading is `again`, unless `mayRetry` says it has
 * been tried enough; then it is kept, events and all.
 */
export function applyRosterPage(
  db: DatabaseSync, asked: readonly string[], page: RosterOk,
  mayRetry: (spaceId: string) => boolean = () => true,
): RosterPageResult {
  const answered = new Set(page.space_ids);
  const topics = new Set<string>();
  const again: string[] = [];

  db.exec('BEGIN');
  try {
    for (const id of asked) {
      if (answered.has(id)) continue;
      db.prepare('DELETE FROM space_rosters WHERE space_id = ?').run(id);
      db.prepare('DELETE FROM space_members WHERE space_id = ?').run(id);
      topics.add(topic.spaceMembers(id));
    }

    const loading = db.prepare(`SELECT 1 FROM space_rosters WHERE space_id = ? AND state = 'loading'`);
    const upsert = db.prepare(`
      INSERT INTO space_members (space_id, actor_id, role, joined_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(space_id, actor_id) DO UPDATE SET role = excluded.role, joined_at = excluded.joined_at
    `);
    for (const row of page.rows) {
      if (!answered.has(row.space_id) || !loading.get(row.space_id)) continue;
      upsert.run(row.space_id, row.actor_id, row.role, row.joined_at);
      topics.add(topic.spaceMembers(row.space_id));
    }

    const past = page.next_after?.space_id ?? null;
    const finished = page.complete || past === null
      ? [...answered]
      : [...answered].filter(id => id < past);
    const state = db.prepare('SELECT state, dirty FROM space_rosters WHERE space_id = ?');
    for (const id of finished) {
      const row = state.get(id) as { state: string; dirty: number } | undefined;
      if (row?.state !== 'loading') continue;
      if (row.dirty === 1 && mayRetry(id)) {
        again.push(id);
        continue;
      }
      db.prepare(`UPDATE space_rosters SET state = 'complete', dirty = 0 WHERE space_id = ?`).run(id);
      recount(db, id);
      topics.add(topic.spaceMembers(id));
      topics.add(topic.space(id));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return { topics: [...topics], again };
}

/**
 * A membership event, for the list it changes. Applied whether the list is
 * held or still loading — a page read before this event would otherwise undo
 * it — and a loading list is marked, so it is fetched once more.
 *
 * Runs inside the apply loop's transaction. Returns whether a list is held.
 */
export function applyMemberEvent(
  db: DatabaseSync, spaceId: string, change: { added: { actorId: string; role: string } } | { removed: string },
): boolean {
  const roster = db.prepare('SELECT state FROM space_rosters WHERE space_id = ?').get(spaceId) as
    { state: string } | undefined;
  if (!roster) return false;

  if ('added' in change) {
    db.prepare(`
      INSERT INTO space_members (space_id, actor_id, role, joined_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(space_id, actor_id) DO UPDATE SET role = excluded.role
    `).run(spaceId, change.added.actorId, change.added.role, Date.now());
  } else {
    db.prepare('DELETE FROM space_members WHERE space_id = ? AND actor_id = ?').run(spaceId, change.removed);
  }

  if (roster.state === 'loading') {
    db.prepare('UPDATE space_rosters SET dirty = 1 WHERE space_id = ?').run(spaceId);
  } else {
    recount(db, spaceId);
  }
  return true;
}

/** A held list is the count: it is current, and `welcome`'s number is from the last connect. */
function recount(db: DatabaseSync, spaceId: string): void {
  db.prepare(`UPDATE spaces SET member_count = (SELECT COUNT(*) FROM space_members WHERE space_id = ?1)
               WHERE id = ?1`).run(spaceId);
}

const ROLE_ORDER = `CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END`;

export function readRoster(db: DatabaseSync, spaceId: string): SpaceRoster {
  const space = db.prepare('SELECT member_count FROM spaces WHERE id = ?').get(spaceId) as
    { member_count: number | null } | undefined;
  const roster = db.prepare('SELECT state FROM space_rosters WHERE space_id = ?').get(spaceId) as
    { state: 'loading' | 'complete' } | undefined;
  const count = space?.member_count ?? null;
  if (roster?.state !== 'complete') return { state: roster?.state ?? 'none', count, members: [] };

  const members = (db.prepare(`
    SELECT m.actor_id, m.role, m.joined_at FROM space_members m
      LEFT JOIN actors a ON a.id = m.actor_id
     WHERE m.space_id = ?
     ORDER BY ${ROLE_ORDER}, a.display_name COLLATE NOCASE, m.actor_id
  `).all(spaceId) as { actor_id: string; role: string; joined_at: number }[])
    .map(row => ({ actorId: row.actor_id, role: row.role, joinedAt: Number(row.joined_at) }));
  return { state: 'complete', count: count ?? members.length, members };
}
