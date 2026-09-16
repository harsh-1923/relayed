// Who is in a space, held on this device (SPACE-MEMBERSHIP-MARKERS.md, rosters).
//
// The property: a list is fetched once, then kept by the space's membership
// events — and never trusted while a page may predate an event it missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { RosterOk } from '@relayed/protocol';
import { migrate } from './migrate.ts';
import { workspaceMigrations } from './migrations/workspace.ts';
import { applyEvent, type Stream } from './apply.ts';
import { replicaEffect } from './effects.ts';
import {
  rostersOwed, beginRosters, applyRosterPage, refetchRoster, wantRoster, readRoster, EAGER_ROSTER_LIMIT,
} from './roster.ts';

function replica(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db, workspaceMigrations);
  return db;
}

/** A space this person is in. */
function space(db: DatabaseSync, id: string, kind: string, count: number | null = null): void {
  const direct = kind === 'dm' || kind === 'group_dm';
  db.prepare(`INSERT INTO spaces (id, workspace_id, kind, name, visibility, membership_policy, member_count,
                                  created_at, updated_at)
              VALUES (?, 'wsp_1', ?, ?, ?, ?, ?, 0, 0)`)
    .run(id, kind, direct ? null : id, direct ? null : 'public', direct ? 'sealed' : 'open', count);
  db.prepare(`INSERT INTO memberships (scope_type, scope_id, actor_id, role, joined_at)
              VALUES ('space', ?, 'act_me', 'member', 0)`).run(id);
}

const page = (ids: string[], rows: [string, string, string][], rest: Partial<RosterOk> = {}): RosterOk => ({
  space_ids: ids,
  rows: rows.map(([space_id, actor_id, role]) => ({ space_id, actor_id, role, joined_at: 1 })),
  next_after: null,
  complete: true,
  ...rest,
});

const members = (db: DatabaseSync, id: string): string[] =>
  readRoster(db, id).members.map(member => `${member.actorId}:${member.role}`);

const event = (db: DatabaseSync, id: string, rev: number, type: string, payload: unknown) =>
  applyEvent({ db, effect: replicaEffect(undefined, () => 'act_me', () => 'wsp_1') },
    { kind: 'space', id } as Stream, { rev, type, payload });

test('rooms and group messages are owed at once, a channel only while it is small, a DM never', () => {
  const db = replica();
  space(db, 'spc_room', 'room');
  space(db, 'spc_group', 'group_dm');
  space(db, 'spc_small', 'channel', 12);
  space(db, 'spc_big', 'channel', EAGER_ROSTER_LIMIT + 1);
  space(db, 'spc_dm', 'dm');
  assert.deepEqual(rostersOwed(db), ['spc_group', 'spc_room', 'spc_small']);

  assert.equal(wantRoster(db, 'spc_big'), true, 'a surface asking is what makes a big one owed');
  assert.equal(wantRoster(db, 'spc_big'), false, 'and asking twice is one request');
  assert.ok(rostersOwed(db).includes('spc_big'));
  assert.equal(wantRoster(db, 'spc_elsewhere'), false, 'a space this person is not in is never asked about');
});

test('a list lands across pages, admins first, and is complete once the page moves past it', () => {
  const db = replica();
  space(db, 'spc_a', 'room');
  space(db, 'spc_b', 'room');
  db.prepare(`INSERT INTO actors (id, workspace_id, type, handle, display_name, state, updated_at)
              VALUES ('act_zed', 'wsp_1', 'human', 'zed', 'Zed', 'active', 0),
                     ('act_amy', 'wsp_1', 'human', 'amy', 'Amy', 'active', 0)`).run();
  beginRosters(db, ['spc_a', 'spc_b']);
  assert.equal(readRoster(db, 'spc_a').state, 'loading');

  applyRosterPage(db, ['spc_a', 'spc_b'],
    page(['spc_a', 'spc_b'], [['spc_a', 'act_amy', 'member'], ['spc_a', 'act_zed', 'admin'], ['spc_b', 'act_amy', 'member']],
         { complete: false, next_after: { space_id: 'spc_b', actor_id: 'act_amy' } }));
  assert.deepEqual(members(db, 'spc_a'), ['act_zed:admin', 'act_amy:member']);
  assert.equal(readRoster(db, 'spc_a').count, 2, 'a held list is the count');
  assert.equal(readRoster(db, 'spc_b').state, 'loading', 'the page has not moved past b yet');

  applyRosterPage(db, ['spc_a', 'spc_b'], page(['spc_a', 'spc_b'], [['spc_b', 'act_zed', 'member']]));
  assert.deepEqual(members(db, 'spc_b'), ['act_amy:member', 'act_zed:member']);
  assert.deepEqual(rostersOwed(db), [], 'nothing is owed once both are held');
});

test('a space the server refused is dropped, not asked about again', () => {
  const db = replica();
  space(db, 'spc_a', 'room');
  beginRosters(db, ['spc_a']);
  applyRosterPage(db, ['spc_a'], page([], []));
  assert.equal(readRoster(db, 'spc_a').state, 'none');
  db.prepare("DELETE FROM memberships WHERE scope_id = 'spc_a'").run();
  assert.deepEqual(rostersOwed(db), [], 'and once welcome drops the membership, never again');
});

test('membership events keep a held list current, and leave a list never fetched alone', () => {
  const db = replica();
  space(db, 'spc_a', 'room');
  space(db, 'spc_b', 'room');
  beginRosters(db, ['spc_a']);
  applyRosterPage(db, ['spc_a'], page(['spc_a'], [['spc_a', 'act_me', 'member']]));

  event(db, 'spc_a', 1, 'space.member_added', { actor_id: 'act_bob', role: 'member', by_actor_id: 'act_me' });
  assert.deepEqual(members(db, 'spc_a'), ['act_bob:member', 'act_me:member']);
  assert.equal(readRoster(db, 'spc_a').count, 2);

  event(db, 'spc_a', 2, 'space.member_removed', { actor_id: 'act_bob' });
  assert.deepEqual(members(db, 'spc_a'), ['act_me:member']);
  assert.equal(readRoster(db, 'spc_a').count, 1);

  event(db, 'spc_b', 1, 'space.member_added', { actor_id: 'act_bob', role: 'member', by_actor_id: 'act_me' });
  assert.equal(readRoster(db, 'spc_b').state, 'none', 'no list is invented from one event');
});

test('an event mid-fetch sends the list back for another fetch, a bounded number of times', () => {
  const db = replica();
  space(db, 'spc_a', 'room');
  beginRosters(db, ['spc_a']);
  // The page was read before Carol left; her removal arrived first.
  event(db, 'spc_a', 1, 'space.member_removed', { actor_id: 'act_carol' });
  const stale = page(['spc_a'], [['spc_a', 'act_me', 'member'], ['spc_a', 'act_carol', 'member']]);

  const first = applyRosterPage(db, ['spc_a'], stale);
  assert.deepEqual(first.again, ['spc_a'], 'the page may predate the event, so it is not trusted');
  assert.equal(readRoster(db, 'spc_a').state, 'loading');
  assert.deepEqual(rostersOwed(db), ['spc_a']);

  beginRosters(db, ['spc_a']);
  event(db, 'spc_a', 2, 'space.member_added', { actor_id: 'act_dan', role: 'member', by_actor_id: 'act_me' });
  const given = applyRosterPage(db, ['spc_a'], page(['spc_a'], [['spc_a', 'act_me', 'member']]), () => false);
  assert.deepEqual(given.again, [], 'out of retries, the list is kept with its events applied');
  assert.deepEqual(members(db, 'spc_a'), ['act_dan:member', 'act_me:member']);
  assert.equal(readRoster(db, 'spc_a').state, 'complete');
});

test('a gap sends a held list back to be fetched, and leaves one never fetched alone', () => {
  const db = replica();
  space(db, 'spc_a', 'room');
  space(db, 'spc_big', 'channel', EAGER_ROSTER_LIMIT + 50);
  beginRosters(db, ['spc_a']);
  applyRosterPage(db, ['spc_a'], page(['spc_a'], [['spc_a', 'act_me', 'member']]));

  assert.deepEqual(refetchRoster(db, 'spc_a'), ['space:spc_a:members']);
  assert.equal(readRoster(db, 'spc_a').state, 'loading');
  assert.deepEqual(members(db, 'spc_a'), []);
  assert.deepEqual(refetchRoster(db, 'spc_big'), [], 'a big channel nobody opened stays unfetched');
});
