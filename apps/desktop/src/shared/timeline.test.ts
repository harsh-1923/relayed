// Reading a room's timeline (docs/MEMORY.md §14.4) — the pure parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byDay, messageCount, visibleEntries, type TimelineEntry } from './timeline.ts';

const entry = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id: 'tle_1', spaceId: 'spc_1', chatId: 'cht_1', ordStart: 1, ordEnd: 6,
  anchorMessageId: 'msg_1',
  occurredStart: Date.parse('2026-09-18T09:33:00Z'), occurredEnd: Date.parse('2026-09-18T09:51:00Z'),
  title: 'Rollback before retry', summary: 'They rolled back.', facts: [], participants: [],
  kind: 'episode', significance: 0, deleted: false, rev: 1, updatedAt: 0, ...over,
});

test('a tombstoned entry is held but never drawn', () => {
  // The replica keeps it so a late update cannot resurrect it; the panel must
  // not show a conversation the room has forgotten.
  const entries = [entry({ id: 'a' }), entry({ id: 'b', deleted: true })];
  assert.deepEqual(visibleEntries(entries).map(one => one.id), ['a']);
});

test('the message count is the ord range, inclusive of both ends', () => {
  assert.equal(messageCount({ ordStart: 1, ordEnd: 6 }), 6);
  assert.equal(messageCount({ ordStart: 9, ordEnd: 9 }), 1);
});

test('entries group under the day they HAPPENED, newest first', () => {
  const days = byDay([
    entry({ id: 'old', occurredStart: Date.parse('2026-09-16T10:00:00Z') }),
    entry({ id: 'newest', occurredStart: Date.parse('2026-09-18T17:00:00Z') }),
    entry({ id: 'same-day', occurredStart: Date.parse('2026-09-18T09:00:00Z') }),
  ]);
  assert.equal(days.length, 2);
  assert.deepEqual(days[0]?.entries.map(one => one.id), ['newest', 'same-day']);
  assert.deepEqual(days[1]?.entries.map(one => one.id), ['old']);
});

test('grouping is by calendar day, never by elapsed hours', () => {
  // A backfill that ran last night must not file a March conversation under
  // today, and 00:30 reads as today rather than as "nine hours ago".
  const justAfterMidnight = new Date(2026, 8, 18, 0, 30).getTime();
  const lateTheSameDay = new Date(2026, 8, 18, 23, 30).getTime();
  const days = byDay([entry({ id: 'late', occurredStart: lateTheSameDay }),
                      entry({ id: 'early', occurredStart: justAfterMidnight })]);
  assert.equal(days.length, 1, 'both belong to the 18th');
  assert.deepEqual(days[0]?.entries.map(one => one.id), ['late', 'early']);
});

test('byDay does not reorder the caller\'s array', () => {
  const entries = [entry({ id: 'a', occurredStart: 1 }), entry({ id: 'b', occurredStart: 2 })];
  byDay(entries);
  assert.deepEqual(entries.map(one => one.id), ['a', 'b']);
});
