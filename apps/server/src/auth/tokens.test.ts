import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signAccessToken, verifyAccessToken, newRefreshToken, hashRefreshToken } from './tokens.ts';

const claims = {
  actorId: 'act_1', workspaceId: 'wsp_1', orgId: 'org_1',
  deviceId: 'dev_1', sessionId: 'ses_1',
};

test('round-trips every claim the socket needs', async () => {
  const out = await verifyAccessToken(await signAccessToken(claims));
  assert.deepEqual(out, claims);
});

test('carries device_id — which a WorkOS token cannot express', async () => {
  const out = await verifyAccessToken(await signAccessToken({ ...claims, deviceId: 'dev_laptop' }));
  assert.equal(out.deviceId, 'dev_laptop');
});

test('rejects a tampered token', async () => {
  const t = await signAccessToken(claims);
  const [h, p, s] = t.split('.');
  const forged = JSON.parse(Buffer.from(p!, 'base64url').toString());
  forged.sub = 'act_someone_else';
  const tampered = [h, Buffer.from(JSON.stringify(forged)).toString('base64url'), s].join('.');
  await assert.rejects(verifyAccessToken(tampered));
});

test('rejects an unsigned "alg: none" token', async () => {
  // Algorithm confusion: the verifier pins EdDSA, so a token asserting its own
  // algorithm is refused.
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'act_evil', iss: 'relayed', aud: 'relayed-client' })).toString('base64url');
  await assert.rejects(verifyAccessToken(`${header}.${payload}.`));
});

test('refresh tokens are opaque, unguessable and stored only as a hash', () => {
  const a = newRefreshToken(), b = newRefreshToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40);
  assert.doesNotMatch(a, /\./, 'not a JWT — it must be revocable, not self-validating');
  const h = hashRefreshToken(a);
  assert.notEqual(h, a);
  assert.equal(h, hashRefreshToken(a), 'hash is stable');
});
