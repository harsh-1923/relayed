// When the composer says it is typing (ACTIVITY.md §6.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TypingSender, ACTIVE_EVERY_MS, IDLE_AFTER_MS, type SenderClock } from './typing-sender.ts';

function harness() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 0;
  const clock: SenderClock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: handle => { timers.delete(handle as number); },
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(id); timer.fn(); }
    }
  };
  const sent: string[] = [];
  const sender = new TypingSender(state => { sent.push(state); }, clock);
  return { sender, sent, advance };
}

test('the first keystroke says typing, and keystrokes inside the interval say nothing more', () => {
  const { sender, sent, advance } = harness();
  sender.changed(true);
  advance(1_000); sender.changed(true);
  advance(1_999); sender.changed(true);
  assert.deepEqual(sent, ['active']);
  advance(ACTIVE_EVERY_MS - 2_999); sender.changed(true);
  assert.deepEqual(sent, ['active', 'active'], 'again once the interval has passed');
});

test('emptying the composer says stopped, once', () => {
  const { sender, sent } = harness();
  sender.changed(true);
  sender.changed(false);
  sender.changed(false);
  assert.deepEqual(sent, ['active', 'ended']);
});

test('a pause says stopped, and typing again says typing at once', () => {
  const { sender, sent, advance } = harness();
  sender.changed(true);
  advance(IDLE_AFTER_MS);
  assert.deepEqual(sent, ['active', 'ended']);
  advance(100); sender.changed(true);
  assert.deepEqual(sent, ['active', 'ended', 'active']);
});

test('each keystroke pushes the pause back', () => {
  const { sender, sent, advance } = harness();
  sender.changed(true);
  advance(4_000); sender.changed(true);
  advance(4_000);
  assert.deepEqual(sent, ['active', 'active'], 'not stopped: the last keystroke was 4 s ago');
});

test('stop says nothing when nothing was said', () => {
  const { sender, sent } = harness();
  sender.stop();
  sender.changed(false);
  assert.deepEqual(sent, []);
});
