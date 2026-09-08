import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHandle, handleCandidates, RESERVED } from './handle.ts';

test('accepts a well-formed handle', () => {
  for (const h of ['harsh', 'deploy-bot', 'a.b_c', 'harsh2']) assert.equal(validateHandle(h), null);
});

test('rejects malformed handles with a specific reason', () => {
  assert.equal(validateHandle('ab'), 'too_short');
  assert.equal(validateHandle('a'.repeat(31)), 'too_long');
  assert.equal(validateHandle('1harsh'), 'bad_start');
  assert.equal(validateHandle('harsh!'), 'bad_chars');
  assert.equal(validateHandle('harsh sharma'), 'bad_chars');
});

test('reserved names cannot be claimed', () => {
  for (const r of RESERVED) assert.equal(validateHandle(r), 'reserved', r);
  // @everyone must never resolve to a person.
  assert.equal(validateHandle('EVERYONE'), 'reserved');
});

test('candidates come from the email local-part and the name', () => {
  const c = handleCandidates('harsh.sharma@example.com', 'Harsh Sharma');
  assert.ok(c.includes('harsh.sharma'));
  assert.ok(c.includes('harsh'));
  assert.ok(c.includes('hsharma'));
  assert.equal(new Set(c).size, c.length, 'no duplicates');
});

test('candidates are never numerically suffixed', () => {
  // §10: auto-suffixing is what a flow does when it declines to ask.
  for (const h of handleCandidates('harsh@example.com', 'Harsh Sharma')) {
    assert.doesNotMatch(h, /\d+$/, `${h} looks auto-suffixed`);
  }
});

test('every candidate is itself valid', () => {
  for (const email of ['a.b@x.com', '1234@x.com', 'Ünïcode@x.com', 'x@y.com']) {
    for (const h of handleCandidates(email, 'Ünïcode Nàme')) {
      assert.equal(validateHandle(h), null, `${email} -> ${h}`);
    }
  }
});

test('an unusable email simply yields no candidates', () => {
  // The caller prompts rather than inventing something.
  assert.deepEqual(handleCandidates('12@x.com', ''), []);
});
