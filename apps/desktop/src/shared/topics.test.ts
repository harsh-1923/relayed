import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topic, topicsIntersect, topicsTouched } from './topics.ts';

test('a topic intersects itself', () => {
  assert.equal(topicsIntersect('actors', 'actors'), true);
  assert.equal(topicsIntersect(topic.actors(), topic.actors()), true);
});

test('a narrow write wakes a broad reader', () => {
  // The sidebar watches every chat; a message lands in one of them.
  assert.equal(topicsIntersect('chat', 'chat:c_eng:messages'), true);
  assert.equal(topicsIntersect('chat:c_eng', 'chat:c_eng:messages'), true);
});

test('a broad write wakes a narrow reader', () => {
  // The other direction, and the one a "subscription must be the prefix" rule
  // would miss: a full directory resync cannot say which actors changed, so an
  // open profile card must still be woken by the coarse topic.
  assert.equal(topicsIntersect('actors:a_alice', 'actors'), true);
  assert.equal(topicsIntersect('chat:c_eng:messages', 'chat'), true);
});

test('sibling facets do not wake each other', () => {
  // The property that stops a new message refetching the member list. Both are
  // still woken by anything subscribed to 'chat:c_eng'.
  assert.equal(topicsIntersect('chat:c_eng:meta', 'chat:c_eng:messages'), false);
  assert.equal(topicsIntersect('chat:c_eng:thread:m_88', 'chat:c_eng:messages'), false);
  // ...and a thread reply does not refetch the chat view, which is correct:
  // replies share the ord space but never appear there (DESIGN.md §8.2).
  assert.equal(topicsIntersect('chat:c_eng:messages', 'chat:c_eng:thread:m_88'), false);
});

test('unrelated roots never intersect', () => {
  assert.equal(topicsIntersect('actors', 'chat:c_eng:messages'), false);
  assert.equal(topicsIntersect('chat:c_eng', 'chat:c_rand'), false);
});

test('a shared string prefix is NOT a shared topic prefix', () => {
  // The near-miss the trailing ':' exists for. Two chats whose ids share a
  // prefix would otherwise wake each other for ever.
  assert.equal(topicsIntersect('chat:c_eng', 'chat:c_engineering'), false);
  assert.equal(topicsIntersect('chat:c_engineering', 'chat:c_eng'), false);
  assert.equal(topicsIntersect('actors', 'actorsomething'), false);
});

test('topicsTouched is true when any pair intersects', () => {
  const sidebar = ['chat', 'actors'];
  assert.equal(topicsTouched(sidebar, ['chat:c_eng:messages']), true);
  assert.equal(topicsTouched(sidebar, ['actors:a_alice']), true);
  assert.equal(topicsTouched(sidebar, ['workspace:ws_1']), false);
  assert.equal(topicsTouched([], ['actors']), false);
  assert.equal(topicsTouched(['actors'], []), false);
});
