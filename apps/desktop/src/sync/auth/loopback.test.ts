import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listenForCallback } from './loopback.ts';

test('binds an ephemeral port on 127.0.0.1 only', async () => {
  const l = await listenForCallback({ state: 's' });
  assert.match(l.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  l.close();
});

test('resolves with the code and serves a closable page', async () => {
  const l = await listenForCallback({ state: 'st_abc' });
  const res = await fetch(`${l.redirectUri}?code=xyz&state=st_abc`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /close this window/);
  assert.equal((await l.result).code, 'xyz');
});

test('rejects a forged state without surfacing the code', async () => {
  const l = await listenForCallback({ state: 'st_real' });
  const res = await fetch(`${l.redirectUri}?code=xyz&state=st_FORGED`);
  assert.equal(res.status, 400);
  await assert.rejects(l.result, /state mismatch/);
});

test('surfaces a provider error', async () => {
  const l = await listenForCallback({ state: 's' });
  const res = await fetch(`${l.redirectUri}?error=access_denied&state=s`);
  assert.equal(res.status, 400);
  await assert.rejects(l.result, /access_denied/);
});

test('ignores any other path', async () => {
  const l = await listenForCallback({ state: 's' });
  const port = new URL(l.redirectUri).port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status, 404);
  l.close();
});

test('closing the listener SETTLES anyone waiting on it', async () => {
  // The bug this exists for: close() stopped the server and left `result`
  // pending for ever. A caller awaiting it waited for ever too — which is how
  // an abandoned sign-in stranded the UI on "waiting for the browser", with the
  // five-minute timeout that would have rescued it already cancelled by the
  // same close().
  const l = await listenForCallback({ state: 's' });
  const settled = l.result.then(() => 'resolved').catch(() => 'rejected');
  l.close();
  const race = await Promise.race([
    settled,
    new Promise(r => setTimeout(() => r('STILL PENDING'), 250)),
  ]);
  assert.equal(race, 'rejected');
});

test('closing after a successful callback does not overturn the result', async () => {
  // close() rejects, and the success path calls close() straight after
  // settling. The first settlement has to win, or every successful sign-in
  // would end in an error.
  const l = await listenForCallback({ state: 'st' });
  await fetch(`${l.redirectUri}?code=abc&state=st`);
  assert.deepEqual(await l.result, { code: 'abc', state: 'st' });
  l.close();
  assert.deepEqual(await l.result, { code: 'abc', state: 'st' }, 'still resolved');
});

test('times out and stops listening', async () => {
  const l = await listenForCallback({ state: 's', timeoutMs: 250 });
  await assert.rejects(l.result, /timed out/);
  await assert.rejects(fetch(l.redirectUri), () => true);
});
