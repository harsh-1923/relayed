// A refused connection coming back by itself (reauth.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReauth, type ReauthDeps } from './reauth.ts';

/** Timers the test runs by hand, and a session whose next refreshes it scripts. */
function harness(over: { held?: string | null; refreshes: (string | null)[]; signedOut?: boolean }) {
  const timers: { fn: () => void; ms: number }[] = [];
  let held = over.held ?? 'expired_token';
  const refreshes = [...over.refreshes];
  let retries = 0;
  let refreshCalls = 0;
  const deps: ReauthDeps = {
    refresh: async () => {
      refreshCalls++;
      const next = refreshes.shift() ?? null;
      if (next) held = next;
      return next;
    },
    held: () => held,
    signedOut: () => over.signedOut ?? false,
    retryNow: () => { retries++; },
    random: () => 1,
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancel: () => {},
  };
  const reauth = createReauth(deps);
  const runNextTimer = async () => {
    const next = timers.shift();
    assert.ok(next, 'a retry should have been scheduled');
    next.fn();
    await new Promise(resolve => setImmediate(resolve));
    return next.ms;
  };
  return { reauth, runNextTimer, timers, get retries() { return retries; }, get refreshCalls() { return refreshCalls; } };
}

test('refused with an expired token: refreshes, then reconnects with the new one', async () => {
  const h = harness({ refreshes: ['fresh_token'] });
  h.reauth.onState('unauthorised');
  await h.runNextTimer();
  assert.equal(h.refreshCalls, 1);
  assert.equal(h.retries, 1);
});

test('a refresh that fails while the server comes back up is tried again, backing off', async () => {
  const h = harness({ refreshes: [null, null, 'fresh_token'] });
  h.reauth.onState('unauthorised');
  const delays = [await h.runNextTimer(), await h.runNextTimer(), await h.runNextTimer()];
  assert.equal(h.retries, 1, 'reconnects once a token finally comes');
  assert.ok(delays[1]! > delays[0]! && delays[2]! > delays[1]!, `each wait longer than the last: ${delays.join(', ')}`);
});

test('a still-valid token the server refused is not retried in a loop', async () => {
  const h = harness({ held: 'valid_token', refreshes: ['valid_token'] });
  h.reauth.onState('unauthorised');
  await h.runNextTimer();
  assert.equal(h.retries, 0);
  assert.equal(h.timers.length, 0, 'nothing further scheduled: waiting cannot fix this');
});

test('signed out: nothing to refresh, so nothing is scheduled', () => {
  const h = harness({ refreshes: [], signedOut: true });
  h.reauth.onState('unauthorised');
  assert.equal(h.timers.length, 0);
});

test('revived by something else while waiting: the scheduled attempt does nothing', async () => {
  const h = harness({ refreshes: ['fresh_token'] });
  h.reauth.onState('unauthorised');
  h.reauth.onState('connecting');
  await h.runNextTimer();
  assert.equal(h.refreshCalls, 0);
  assert.equal(h.retries, 0);
});

test('repeated unauthorised states while one attempt is pending schedule only one', () => {
  const h = harness({ refreshes: ['fresh_token'] });
  h.reauth.onState('unauthorised');
  h.reauth.onState('unauthorised');
  assert.equal(h.timers.length, 1);
});
