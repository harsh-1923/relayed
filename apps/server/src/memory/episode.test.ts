// Where an episode ends, and what is not worth sending (docs/MEMORY.md §6.1, §6.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '../db/ulid.ts';
import {
  buildEpisodeText, firstEpisode, readyToIngest, MAX_EPISODE, QUIET_MINUTES,
  type EpisodeMessage,
} from './episode.ts';

const base = Date.parse('2026-09-15T09:00:00Z');

/** A message `minutes` after 09:00, on ordinal `ord`. */
const at = (minutes: number, ord: number, body = 'a substantive sentence about the cutover'): EpisodeMessage => ({
  id: ulid('msg'), ord, rev: ord, body, createdAt: new Date(base + minutes * 60_000),
  authorId: 'act_01M2AAAA', authorDisplayName: 'Priya Rao', authorHandle: 'priya', authorType: 'human',
});

test('an episode ends at the FIRST quiet gap, not the last', () => {
  // 09:00 talk, a two-hour gap, 11:00 talk. Merging them would ask extraction
  // to find the relation between two conversations that have none.
  const episode = firstEpisode([at(0, 1), at(2, 2), at(4, 3), at(124, 4), at(126, 5)]);
  assert.deepEqual(episode.map((message) => message.ord), [1, 2, 3]);
});

test('a gap shorter than the quiet window does not end an episode', () => {
  const episode = firstEpisode([at(0, 1), at(QUIET_MINUTES - 1, 2), at(QUIET_MINUTES + 5, 3)]);
  assert.deepEqual(episode.map((message) => message.ord), [1, 2, 3]);
});

test('a chat that never goes quiet is still cut at MAX_EPISODE', () => {
  const messages = Array.from({ length: MAX_EPISODE + 20 }, (_, index) => at(index, index + 1));
  assert.equal(firstEpisode(messages).length, MAX_EPISODE);
});

test('nothing pending is not an episode', () => {
  assert.deepEqual(firstEpisode([]), []);
  assert.equal(readyToIngest([], new Date()), false);
});

test('a conversation still in progress is not ready', () => {
  const episode = firstEpisode([at(0, 1), at(1, 2)]);
  const stillTalking = new Date(base + 2 * 60_000);
  assert.equal(readyToIngest(episode, stillTalking), false);
});

test('a conversation that has gone quiet is ready', () => {
  const episode = firstEpisode([at(0, 1), at(1, 2)]);
  const later = new Date(base + (1 + QUIET_MINUTES + 1) * 60_000);
  assert.equal(readyToIngest(episode, later), true);
});

test('a full episode is ready even mid-conversation, or it would never be taken', () => {
  const messages = Array.from({ length: MAX_EPISODE + 5 }, (_, index) => at(index, index + 1));
  const episode = firstEpisode(messages);
  const stillTalking = new Date(base + MAX_EPISODE * 60_000);
  assert.equal(readyToIngest(episode, stillTalking), true);
});

// Nothing is filtered on the way in: an episode of nothing but `lol` and `🎉`
// is sent like any other, and extraction decides there is nothing to remember.
// An earlier draft gated this locally and the arithmetic never supported it —
// retain bills per input token, so a filter can only drop the cheap episodes
// while risking the one real sentence buried among the reactions.

// ─── The transcript ─────────────────────────────────────────────────────────

test('every line carries the actor id and the time, and nothing is compressed', () => {
  const text = buildEpisodeText([at(0, 1, 'the rebuild will not finish'), at(1, 2, 'roll it back')]);
  assert.match(text, /Priya Rao \(@priya, act_01M2AAAA\) 2026-09-15T09:00:00\.000Z: the rebuild will not finish/);
  assert.match(text, /2026-09-15T09:01:00\.000Z: roll it back/);
  assert.equal(text.split('\n').length, 2);
});

test('an agent is labelled as one, so extraction does not read it as a person', () => {
  const message = { ...at(0, 1, 'filed PLAT-2291'), authorType: 'agent', authorHandle: 'triage' };
  assert.match(buildEpisodeText([message]), /\(@triage, agent, act_01M2AAAA\)/);
});
