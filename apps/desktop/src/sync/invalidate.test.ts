import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInvalidator } from './invalidate.ts';

/** Holds the flush so a test can run a whole write loop before it fires. */
function manual() {
  const sent: string[][] = [];
  const ids: number[] = [];
  const flushes: (() => void)[] = [];
  const invalidate = createInvalidator(
    batch => { sent.push(batch.topics); ids.push(batch.invalidation); },
    f => { flushes.push(f); });
  return {
    invalidate, sent, ids,
    flush: () => { const queued = flushes.splice(0); for (const f of queued) f(); },
    scheduled: () => flushes.length,
  };
}

test('a write loop emits ONE push, not one per row', () => {
  const io = manual();
  for (let row = 0; row < 200; row++) io.invalidate(['chat:c_eng:messages']);
  assert.equal(io.scheduled(), 1, 'one flush scheduled for the whole run');
  io.flush();
  assert.deepEqual(io.sent, [['chat:c_eng:messages']]);
});

test('topics are deduplicated but all distinct ones survive', () => {
  const io = manual();
  io.invalidate(['chat:c_eng:messages', 'chat:c_eng:unread']);
  io.invalidate(['chat:c_eng:messages']);
  io.invalidate(['chat:c_rand:messages']);
  io.flush();
  assert.equal(io.sent.length, 1);
  assert.deepEqual([...(io.sent[0] ?? [])].sort(),
    ['chat:c_eng:messages', 'chat:c_eng:unread', 'chat:c_rand:messages']);
});

test('a later batch schedules a new flush rather than joining the last one', () => {
  const io = manual();
  io.invalidate(['actors']);
  io.flush();
  io.invalidate(['chat:c_eng:messages']);
  io.flush();
  assert.deepEqual(io.sent, [['actors'], ['chat:c_eng:messages']]);
});

test('an empty invalidation schedules nothing', () => {
  const io = manual();
  io.invalidate([]);
  assert.equal(io.scheduled(), 0);
  io.flush();
  assert.deepEqual(io.sent, []);
});

test('each flushed batch gets its own id, so a chain can be correlated', () => {
  const io = manual();
  io.invalidate(['actors']);
  io.flush();
  io.invalidate(['actors']);
  io.flush();
  assert.deepEqual(io.ids, [1, 2]);
});

test('the default schedule is a microtask — it flushes without a timer', async () => {
  const sent: string[][] = [];
  const invalidate = createInvalidator(batch => { sent.push(batch.topics); });
  invalidate(['actors']);
  assert.deepEqual(sent, [], 'not synchronous: the write loop is still running');
  await Promise.resolve();
  assert.deepEqual(sent, [['actors']]);
});
