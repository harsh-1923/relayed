// Whether Back and Forward lead anywhere.
//
// Worth asserting rather than clicking, because every way of getting this wrong
// produces a button that LOOKS right. A Forward left lit after a push points at
// entries that no longer exist; a Back disabled on the second screen strands
// you; and neither is visible until somebody walks a specific path through the
// app and notices the button did nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, type Stack } from './use-back-forward.ts';

/** Walk a sequence of navigations from a fresh window. */
const walk = (steps: { cursor: number | null; pushed: boolean }[]): Stack =>
  steps.reduce<Stack>((stack, step) => advance(stack, step), { at: 0, top: 0 });

/** The three things that can happen, spelled once. */
const push = (cursor: number | null) => ({ cursor, pushed: true });
const pop = (cursor: number) => ({ cursor, pushed: false });
const replace = (cursor: number) => ({ cursor, pushed: false });

const canBack = (s: Stack) => s.at > 0;
const canForward = (s: Stack) => s.at < s.top;

test('the first screen has nowhere to go, in either direction', () => {
  const stack = walk([]);
  assert.equal(canBack(stack), false);
  assert.equal(canForward(stack), false);
});

test('pushing makes Back reachable and leaves Forward dead', () => {
  const stack = walk([push(1)]);
  assert.equal(canBack(stack), true);
  assert.equal(canForward(stack), false, 'nothing has been visited ahead of here');
});

test('going back is what makes Forward mean something', () => {
  const stack = walk([
    push(1),
    push(2),
    pop(1),
  ]);
  assert.deepEqual(stack, { at: 1, top: 2 });
  assert.equal(canForward(stack), true);
});

test('A PUSH AFTER GOING BACK DISCARDS WHAT WAS AHEAD', () => {
  // The one that costs you a wrong button. The browser truncates the forward
  // entries on a push, so a `top` left at its old high-water mark leaves Forward
  // lit and pointing at history that no longer exists.
  const stack = walk([
    push(1),
    push(2),
    push(3),
    pop(1),    // back twice
    push(2),   // and somewhere else
  ]);
  assert.deepEqual(stack, { at: 2, top: 2 });
  assert.equal(canForward(stack), false);
});

test('walking all the way back does not forget that forward exists', () => {
  const stack = walk([
    push(1),
    push(2),
    pop(1),
    pop(0),
  ]);
  assert.deepEqual(stack, { at: 0, top: 2 });
  assert.equal(canBack(stack), false);
  assert.equal(canForward(stack), true);
});

test('a REPLACE is not a journey — neither button changes', () => {
  // Redirects use it: the root route replaces itself with the workspace you
  // were last in. Counting that as a step would put a Back button on the first
  // screen after sign-in that returns you to a redirect.
  const before = walk([push(1)]);
  const after = advance(before, replace(1));
  assert.equal(after, before, 'and the same object, so React does not re-render');
});

test('a PARAMETER CHANGE is a navigation like any other', () => {
  // /w/A/c/1 → /w/A/c/2 is the same route, the same component and the same
  // pathname pattern. It is still somewhere Back has to return from, which is
  // why the hook keys on the location rather than on the path.
  const stack = walk([
    push(1),   // open a chat
    push(2),   // open a different one
  ]);
  assert.equal(stack.at, 2);
  assert.equal(canBack(stack), true);
});

test('with no index written yet, a push still counts as forward motion', () => {
  // The first entry of a fresh window, before the history has state on it.
  const stack = walk([push(null)]);
  assert.deepEqual(stack, { at: 1, top: 1 });
  assert.equal(canBack(stack), true);
});

test('applying the same navigation twice changes nothing', () => {
  // StrictMode runs the effect twice for one navigation. If that counted twice,
  // the cursor would run ahead of the real history and Back would be offered
  // where there is nothing behind.
  const once = advance({ at: 0, top: 0 }, push(1));
  const twice = advance(once, push(1));
  assert.equal(twice, once);
});

test('a push with NO index is not idempotent — the gap, and why the index wins', () => {
  // The fallback path is the one where idempotence is not free — there is no
  // index to pin it, so a second application would add another entry that never
  // happened. This is the case that argues for reading the index first.
  const once = advance({ at: 0, top: 0 }, push(null));
  const twice = advance(once, push(null));
  assert.deepEqual(twice, { at: 2, top: 2 },
    'known gap: without an index there is nothing to make this idempotent');
});
