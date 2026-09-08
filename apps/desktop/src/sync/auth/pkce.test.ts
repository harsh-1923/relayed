import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPkce } from './pkce.ts';

const b64url = (b: Buffer) =>
  b.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

test('verifier meets RFC 7636 length and charset', () => {
  const { verifier } = createPkce();
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `length ${verifier.length}`);
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
});

test('challenge is BASE64URL(SHA256(verifier)) with method S256', () => {
  const p = createPkce();
  assert.equal(p.challenge, b64url(createHash('sha256').update(p.verifier).digest()));
  assert.equal(p.method, 'S256');
});

test('every exchange gets fresh values', () => {
  const a = createPkce(), b = createPkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
});

test('state is independent of the verifier', () => {
  // state is CSRF protection for the redirect; deriving it from the verifier
  // would leak the verifier into a URL the browser and server both see.
  const p = createPkce();
  assert.notEqual(p.state, p.verifier);
  assert.ok(p.state.length >= 20);
});
