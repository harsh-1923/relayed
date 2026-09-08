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

test('times out and stops listening', async () => {
  const l = await listenForCallback({ state: 's', timeoutMs: 250 });
  await assert.rejects(l.result, /timed out/);
  await assert.rejects(fetch(l.redirectUri), () => true);
});
