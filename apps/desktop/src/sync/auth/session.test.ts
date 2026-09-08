import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, type SessionDeps } from './session.ts';
import { buildAuthorizeUrl, decodeJwtPayload } from './workos.ts';
import { createPkce } from './pkce.ts';

const jwt = (expSec: number) =>
  'h.' + Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url') + '.s';

function fakeVault() {
  let value: string | null = null;
  let cleared = 0;
  return {
    read: async () => value,
    store: async (t: string) => { value = t; },
    clear: async () => { value = null; cleared++; },
    get stored() { return value; },
    get clearCount() { return cleared; },
  };
}

const deps = (over: Partial<SessionDeps> & { vault: ReturnType<typeof fakeVault> }): SessionDeps => ({
  config: { clientId: 'client_test' },
  deviceId: 'dev_test',
  openBrowser: () => {},
  ...over,
});

test('authorize URL carries PKCE challenge, state and redirect', () => {
  const pkce = createPkce();
  const u = new URL(buildAuthorizeUrl({ clientId: 'client_x' }, pkce, 'http://127.0.0.1:5/auth/callback'));
  assert.equal(u.searchParams.get('client_id'), 'client_x');
  assert.equal(u.searchParams.get('code_challenge'), pkce.challenge);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), pkce.state);
  assert.equal(u.searchParams.get('response_type'), 'code');
  // The verifier must never leave the device.
  assert.ok(!u.toString().includes(pkce.verifier));
});

test('access token expiry is read from the JWT', () => {
  assert.equal(decodeJwtPayload(jwt(1800000000))?.['exp'], 1800000000);
});

test('starts signed out and restores to signed out with an empty vault', async () => {
  const vault = fakeVault();
  const s = new Session(deps({ vault }));
  assert.equal(s.state.status, 'signed_out');
  assert.equal((await s.restore()).status, 'signed_out');
});

test('a failed refresh goes STALE, not signed out — and never clears the vault', async () => {
  // The invariant: a token expiring is not a sign-out. Clearing local data here
  // would be silent data loss.
  const vault = fakeVault();
  await vault.store('rt_stored');
  // RELAYED_SERVER_URL points at a closed port: refresh cannot reach our
  // server, which is the offline case.
  process.env['RELAYED_SERVER_URL'] = 'http://127.0.0.1:1';
  const s = new Session(deps({ vault }));
  const state = await s.restore();
  assert.equal(state.status, 'stale');
  assert.equal(vault.stored, 'rt_stored', 'refresh token must survive a failed refresh');
  assert.equal(vault.clearCount, 0, 'vault must not be cleared by an auth failure');
  delete process.env['RELAYED_SERVER_URL'];
});

test('signOut is the only path that clears the vault', async () => {
  const vault = fakeVault();
  await vault.store('rt');
  const s = new Session(deps({ vault }));
  await s.signOut();
  assert.equal(vault.clearCount, 1);
  assert.equal(vault.stored, null);
  assert.equal(s.state.status, 'signed_out');
  assert.equal(s.accessToken, null);
});

test('sign-in failure returns to signed_out without wiping stored state', async () => {
  const vault = fakeVault();
  await vault.store('rt_existing');
  const s = new Session(deps({
    vault,
    openBrowser: () => { throw new Error('browser unavailable'); },
  }));
  await assert.rejects(s.signIn(), /browser unavailable/);
  assert.equal(s.state.status, 'signed_out');
  assert.equal(vault.stored, 'rt_existing');
});

test('state changes are observable', async () => {
  const seen: string[] = [];
  const s = new Session(deps({ vault: fakeVault() }));
  s.onChange((st) => seen.push(st.status));
  await s.signOut();
  assert.deepEqual(seen, ['signed_out']);
});
