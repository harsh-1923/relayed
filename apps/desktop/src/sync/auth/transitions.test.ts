import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED, assertEdge, type Status } from './transitions.ts';

const ALL = Object.keys(ALLOWED) as Status[];

test('every ordered pair of statuses is either declared or rejected', () => {
  let legal = 0;
  for (const from of ALL) {
    for (const to of ALL) {
      if (from === to || (ALLOWED[from] as readonly Status[]).includes(to)) {
        assertEdge(from, to);
        legal += 1;
      } else {
        assert.throws(() => assertEdge(from, to), /illegal auth transition/,
                      `${from} → ${to} should be rejected`);
      }
    }
  }
  // Asserted as numbers so that widening the table shows up as a failing test
  // rather than as a quiet loosening nobody reviews. Six statuses admit
  // thirty-six ordered pairs; twenty-two of them mean something.
  assert.equal(ALL.length, 6);
  assert.equal(legal, 22);
});

test('a status is always allowed to transition to itself', () => {
  // Re-adopting after a refresh sets `authenticated` over `authenticated`, and
  // that must not be a violation.
  for (const s of ALL) assertEdge(s, s);
});

test('boot reaches authenticated and stale WITHOUT passing through authenticating', () => {
  // The two edges a guess would have missed, and the reason the table was worth
  // writing: `activate` at boot refreshes a stored credential with no browser
  // involved at all, so it goes straight from signed_out to one or the other.
  assertEdge('signed_out', 'authenticated');
  assertEdge('signed_out', 'stale');
});

test('signing in again while already signed in is not a transition we have', () => {
  // Not an oversight. It has no meaning today, and if account switching arrives
  // it is a different flow that should have to declare this edge deliberately.
  assert.throws(() => assertEdge('authenticated', 'authenticating'));
  // Whereas re-authenticating a stale session is the natural recovery, declared
  // ahead of the button that will use it.
  assertEdge('stale', 'authenticating');
});
