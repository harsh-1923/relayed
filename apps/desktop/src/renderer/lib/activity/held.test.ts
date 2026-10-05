// What a window holds about activity (ACTIVITY.md §6.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Activity } from '../../../shared/activity.ts';
import { applyPush, expire, nextExpiry, typistsIn, type Held } from './held.ts';

const typing = (over: Partial<Activity> = {}): Activity => ({
  chat_id: 'chat-1', thread_id: null, actor_id: 'alice', kind: 'typing',
  key: 'alice:1:chat-1:', seq: 0, state: 'active', ttl_ms: 6_000, ...over,
});
const empty: Held = new Map();
const push = (held: Held, activity: Activity, now = 0): Held => applyPush(held, { activity }, now);

test('an active entry is held until arrival plus its ttl', () => {
  const held = push(empty, typing(), 1_000);
  assert.deepEqual([...held.values()].map(e => e.expiresAt), [7_000]);
  assert.equal(nextExpiry(held), 7_000);
  assert.equal(expire(held, 6_999), held, 'nothing changed, so the same map');
  assert.equal(expire(held, 7_000).size, 0);
});

test('a fresh active restarts the countdown', () => {
  let held = push(empty, typing(), 0);
  held = push(held, typing({ seq: 1 }), 3_000);
  assert.equal(nextExpiry(held), 9_000);
});

test('a push older than or equal to what is held is dropped', () => {
  const held = push(empty, typing({ seq: 2 }));
  assert.equal(push(held, typing({ seq: 1 })), held);
  assert.equal(push(held, typing({ seq: 2 })), held);
  assert.equal(push(held, typing({ seq: 1, state: 'ended' })), held, 'a stale end does not remove a newer active');
});

test('ended removes the entry; ending something not held changes nothing', () => {
  const held = push(empty, typing());
  assert.equal(push(held, typing({ seq: 1, state: 'ended' })).size, 0);
  assert.equal(push(empty, typing({ state: 'ended' })), empty);
});

test('after an end the same key may type again from seq 0', () => {
  let held = push(empty, typing());
  held = push(held, typing({ seq: 1, state: 'ended' }));
  held = push(held, typing({ seq: 0 }));
  assert.equal(held.size, 1);
});

test('reset forgets everything', () => {
  const held = push(empty, typing());
  assert.equal(applyPush(held, { reset: true }, 0).size, 0);
  assert.equal(applyPush(empty, { reset: true }, 0), empty);
});

test('a kind this build does not draw is ignored', () => {
  assert.equal(push(empty, typing({ kind: 'recording' })), empty);
});

test('typists are per chat and thread, once per person, in the order they started', () => {
  let held = push(empty, typing({ actor_id: 'bob', key: 'bob:1:chat-1:' }));
  held = push(held, typing({ key: 'alice:1:chat-1:' }));
  held = push(held, typing({ key: 'alice:2:chat-1:' }));                       // Alice's other device
  held = push(held, typing({ actor_id: 'carol', key: 'carol:1:chat-2:', chat_id: 'chat-2' }));
  held = push(held, typing({ actor_id: 'dave', key: 'dave:1:chat-1:t', thread_id: 'root' }));
  held = push(held, typing({ actor_id: 'bob', key: 'bob:1:chat-1:', seq: 1 })); // a refresh keeps Bob first
  assert.deepEqual(typistsIn(held, 'chat-1', null), ['bob', 'alice']);
  assert.deepEqual(typistsIn(held, 'chat-1', 'root'), ['dave']);
  assert.deepEqual(typistsIn(held, 'chat-2', null), ['carol']);
});
