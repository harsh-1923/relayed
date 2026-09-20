import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, stateFor } from './version.ts';

test('versions compare NUMERICALLY, not as text', () => {
  // The bug this exists to prevent: "0.0.10" sorts BEFORE "0.0.9" as a string,
  // so a project would stop offering updates at exactly the point it started
  // shipping them regularly.
  assert.equal(compareVersions('0.0.9', '0.0.10') < 0, true);
  assert.equal(compareVersions('0.0.10', '0.0.9') > 0, true);
  assert.equal(compareVersions('1.0.0', '0.99.99') > 0, true);
});

test('a missing segment is zero, so 1.2 and 1.2.0 are the same build', () => {
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.2', '1.2.1') < 0, true);
});

test('below the floor is REQUIRED, not merely offered', () => {
  const s = stateFor('0.0.1', { latest: '0.0.5', minimum: '0.0.3', url: 'u' });
  assert.equal(s.status, 'update_required');
});

test('behind the latest but above the floor is an OFFER', () => {
  const s = stateFor('0.0.4', { latest: '0.0.5', minimum: '0.0.3', url: 'u' });
  assert.equal(s.status, 'update_available');
});

test('exactly at the floor is allowed — the floor is inclusive', () => {
  // Off-by-one here locks out the build you just told everyone to install.
  const s = stateFor('0.0.3', { latest: '0.0.3', minimum: '0.0.3', url: 'u' });
  assert.equal(s.status, 'ok');
});

test('a default floor of 0.0.0 forces nobody', () => {
  // The server defaults both fields to 0.0.0, so a deploy that forgets to set
  // them offers nothing and blocks nobody — rather than locking every user out
  // of an app that worked a moment ago.
  assert.equal(stateFor('0.0.1', { latest: '0.0.0', minimum: '0.0.0', url: '' }).status, 'ok');
});

test('a build AHEAD of the server is fine, not an error', () => {
  // Running a local build against production is routine, and telling the
  // developer to downgrade would be nonsense.
  assert.equal(stateFor('9.9.9', { latest: '0.0.5', minimum: '0.0.3', url: 'u' }).status, 'ok');
});
