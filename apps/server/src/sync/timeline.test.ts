// A room's timeline as replicated rows (docs/MEMORY.md §14.3) — against Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { createRoom } from './spaces.ts';
import {
  writeTimelineEntry, tombstoneTimelineEntry, spaceTimelineEntries, spaceHasTimeline,
  UNCLASSIFIED, WELCOME_ENTRIES_PER_SPACE, type TimelineEntryInput,
} from './timeline.ts';
import { welcome } from './feed.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const alice = ulid('act');

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Timeline' }).execute();
  await db.insertInto('workspaces').values({
    id: wsp, org_id: org, name: 'Timeline', slug: `t-${wsp.slice(-8).toLowerCase()}`,
  }).execute();
  await db.insertInto('actors').values({
    id: alice, org_id: org, workspace_id: wsp, type: 'human', handle: `t-${alice.slice(-8).toLowerCase()}`,
    display_name: 'Alice', avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${alice}`,
    owner_actor_id: null, provisioned_by: 'api', state: 'active',
  }).execute();
  await db.insertInto('memberships').values({
    scope_type: 'workspace', scope_id: wsp, actor_id: alice, role: 'member',
  }).execute();
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

const room = () => createRoom(db, { workspaceId: wsp, name: `r-${ulid('x')}`, createdBy: alice });

/** One episode's worth of input, with the bits a test cares about overridable. */
const episode = (
  place: { spaceId: string; chatId: string }, over: Partial<TimelineEntryInput> = {},
): TimelineEntryInput => ({
  workspaceId: wsp, spaceId: place.spaceId, chatId: place.chatId,
  ordStart: 1, ordEnd: 9, anchorMessageId: null,
  occurredStart: new Date('2026-09-18T10:00:00Z'), occurredEnd: new Date('2026-09-18T10:18:00Z'),
  title: 'Rollback before retry',
  summary: 'The team decided to roll back the index rebuild before retrying the cutover.',
  facts: [{ text: 'Decided to roll back the index rebuild first', message_id: null, kind: null }],
  participants: [alice],
  ...over,
});

test('an entry is written with its facts, and unclassified until something classifies it', opts, async () => {
  const place = await room();
  const { entry } = await writeTimelineEntry(db, episode(place));

  assert.equal(entry.title, 'Rollback before retry');
  assert.equal(entry.rev, 1);
  assert.equal(entry.deleted, false);
  assert.deepEqual(entry.participants, [alice]);
  assert.deepEqual(entry.facts, [
    { text: 'Decided to roll back the index rebuild first', message_id: null, kind: null },
  ]);
  // Not 'decision'. The extraction mission names the kinds in prose but nothing
  // labels what comes back, so the filter has nothing to filter on yet (§14.5).
  assert.equal(entry.kind, UNCLASSIFIED);
  // The messages' time, not now.
  assert.equal(entry.occurred_start, '2026-09-18T10:00:00.000Z');
});

test('re-ingesting the same range CORRECTS the entry rather than adding a second', opts, async () => {
  const place = await room();
  const first = await writeTimelineEntry(db, episode(place));
  // What the forget path does: the same episode, re-retained without a deleted
  // message. A second row here would leave the room showing both versions.
  const second = await writeTimelineEntry(db, episode(place, {
    title: 'Rollback before retry (corrected)',
    facts: [{ text: 'Bob Iyer owns the rollback script', message_id: null, kind: null }],
  }));

  assert.equal(second.entry.id, first.entry.id, 'the same row, keyed on the episode');
  assert.equal(second.entry.rev, 2, 'rev climbs, so a late event cannot wind it back');
  assert.equal(second.entry.title, 'Rollback before retry (corrected)');

  const all = await spaceTimelineEntries(db, [place.spaceId]);
  assert.equal(all.length, 1);
});

test('a different range in the same chat is a different entry', opts, async () => {
  const place = await room();
  await writeTimelineEntry(db, episode(place, { ordStart: 1, ordEnd: 9 }));
  await writeTimelineEntry(db, episode(place, {
    ordStart: 10, ordEnd: 21, occurredStart: new Date('2026-09-18T14:00:00Z'),
    occurredEnd: new Date('2026-09-18T14:30:00Z'), title: 'Cutover window moved',
  }));

  const all = await spaceTimelineEntries(db, [place.spaceId]);
  assert.deepEqual(all.map(one => one.title), ['Cutover window moved', 'Rollback before retry'],
    'newest first — which is the order the panel opens in');
});

test('a tombstone keeps the row and climbs rev, so a late update cannot resurrect it', opts, async () => {
  const place = await room();
  const { entry } = await writeTimelineEntry(db, episode(place));

  const event = await tombstoneTimelineEntry(db, { chatId: place.chatId, ordStart: 1, ordEnd: 9 });
  assert.ok(event, 'the removal is an event like any other write');

  const row = await db.selectFrom('room_timeline_entries').select(['deleted', 'rev'])
    .where('id', '=', entry.id).executeTakeFirstOrThrow();
  assert.equal(row.deleted, true, 'a tombstone, not a delete');
  assert.equal(row.rev, 2);

  // Tombstones replicate: a client holding the entry needs the row that says
  // it is gone, which is why this is not filtered out of the read.
  const [carried] = await spaceTimelineEntries(db, [place.spaceId]);
  assert.equal(carried?.deleted, true);
});

test('writing an episode again undeletes it — a rebuild that finds something brings it back', opts, async () => {
  const place = await room();
  await writeTimelineEntry(db, episode(place));
  await tombstoneTimelineEntry(db, { chatId: place.chatId, ordStart: 1, ordEnd: 9 });
  const { entry } = await writeTimelineEntry(db, episode(place));

  assert.equal(entry.deleted, false);
  assert.equal(entry.rev, 3);
});

test('tombstoning an episode with no entry is null, not a throw', opts, async () => {
  const place = await room();
  // The forget path runs over memory documents, and one written before this
  // table existed has no entry to remove.
  assert.equal(await tombstoneTimelineEntry(db, { chatId: place.chatId, ordStart: 1, ordEnd: 9 }), null);
  // Nor does tombstoning twice produce a second event.
  await writeTimelineEntry(db, episode(place));
  assert.ok(await tombstoneTimelineEntry(db, { chatId: place.chatId, ordStart: 1, ordEnd: 9 }));
  assert.equal(await tombstoneTimelineEntry(db, { chatId: place.chatId, ordStart: 1, ordEnd: 9 }), null);
});

test('a room with FEWER entries than the cap gets all of them', opts, async () => {
  // The bug this exists for: "newer than this space's 50th entry" is the
  // obvious query and returns NULL for a young room, and `>= NULL` is UNKNOWN
  // rather than true — so every room under the cap would have come back empty.
  const place = await room();
  for (let n = 0; n < 3; n++) {
    await writeTimelineEntry(db, episode(place, {
      ordStart: n * 10 + 1, ordEnd: n * 10 + 9,
      occurredStart: new Date(Date.UTC(2026, 8, 18, 10 + n)),
      occurredEnd: new Date(Date.UTC(2026, 8, 18, 10 + n, 20)),
      title: `Episode ${n}`,
    }));
  }
  const all = await spaceTimelineEntries(db, [place.spaceId]);
  assert.deepEqual(all.map(one => one.title), ['Episode 2', 'Episode 1', 'Episode 0']);
});

test('welcome carries the newest page of each joined room\'s timeline, and no more', opts, async () => {
  const place = await room();
  const total = WELCOME_ENTRIES_PER_SPACE + 5;
  for (let n = 0; n < total; n++) {
    await writeTimelineEntry(db, episode(place, {
      ordStart: n * 10 + 1, ordEnd: n * 10 + 9,
      occurredStart: new Date(Date.UTC(2026, 0, 1) + n * 3_600_000),
      occurredEnd: new Date(Date.UTC(2026, 0, 1) + n * 3_600_000 + 60_000),
      title: `Episode ${n}`,
    }));
  }

  const payload = await welcome(db, wsp, alice);
  const mine = payload.timelineEntries.filter(one => one.space_id === place.spaceId);
  assert.equal(mine.length, WELCOME_ENTRIES_PER_SPACE, 'capped per space — a timeline grows for ever');
  assert.equal(mine[0]?.title, `Episode ${total - 1}`, 'the newest page, not the oldest');
});

test('only a room keeps a timeline', () => {
  // A property of the SURFACE, not of the table: the panel a timeline is read
  // in is structural to a room and exists nowhere else, so an entry for a DM is
  // a row, an event and a narration call nobody can ever see.
  assert.ok(spaceHasTimeline('room'));
  for (const kind of ['channel', 'dm', 'group_dm']) {
    assert.ok(!spaceHasTimeline(kind), kind);
  }
});
