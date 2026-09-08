import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, type SessionDeps } from './session.ts';
import { buildAuthorizeUrl, decodeJwtPayload } from './workos.ts';
import { createPkce } from './pkce.ts';

const jwt = (expSec: number) =>
  'h.' + Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url') + '.s';

const WSP_A = 'wsp_alpha';
const WSP_B = 'wsp_beta';

/** One slot per workspace, like the real vault (STORAGE.md §9). */
function fakeVault() {
  const slots = new Map<string, string>();
  const cleared: string[] = [];
  return {
    read: async (wsp: string) => slots.get(wsp) ?? null,
    store: async (wsp: string, t: string) => { slots.set(wsp, t); },
    clear: async (wsp: string) => { slots.delete(wsp); cleared.push(wsp); },
    get slots() { return slots; },
    get cleared() { return cleared; },
  };
}

const deps = (over: Partial<SessionDeps> & { vault: ReturnType<typeof fakeVault> }): SessionDeps => ({
  config: { clientId: 'client_test' },
  deviceId: () => 'dev_test',
  openBrowser: () => {},
  ...over,
});

/** Points refresh at a closed port, which is the offline case. */
function offline<T>(fn: () => Promise<T>): Promise<T> {
  process.env['RELAYED_SERVER_URL'] = 'http://127.0.0.1:1';
  return fn().finally(() => { delete process.env['RELAYED_SERVER_URL']; });
}

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

test('starts signed out, and an empty slot with no held session stays signed out', async () => {
  const vault = fakeVault();
  const s = new Session(deps({ vault }));
  assert.equal(s.state.status, 'signed_out');
  // Boot: nothing stored for this workspace and no session in hand. There is
  // nothing to bootstrap FROM, so this is genuinely signed out rather than a
  // failed switch.
  assert.equal((await s.activate(WSP_A)).status, 'signed_out');
});

test('a failed refresh goes STALE, not signed out — and never clears the vault', async () => {
  // The invariant: a token expiring is not a sign-out. Clearing local data here
  // would be silent data loss.
  const vault = fakeVault();
  await vault.store(WSP_A, 'rt_stored');
  const s = new Session(deps({ vault }));
  const state = await offline(() => s.activate(WSP_A));
  assert.equal(state.status, 'stale');
  assert.equal(vault.slots.get(WSP_A), 'rt_stored', 'refresh token must survive a failed refresh');
  assert.equal(vault.cleared.length, 0, 'vault must not be cleared by an auth failure');
});

test('vault slots are per workspace', async () => {
  const vault = fakeVault();
  await vault.store(WSP_A, 'rt_a');
  await vault.store(WSP_B, 'rt_b');
  const s = new Session(deps({ vault }));

  // Activating A must not touch B: switching away from a workspace keeps its
  // credential, which is what leaves it drainable (STORAGE.md §9).
  await offline(() => s.activate(WSP_A));
  assert.equal(vault.slots.get(WSP_B), 'rt_b');
  assert.equal(s.workspaceId, WSP_A);

  await offline(() => s.activate(WSP_B));
  assert.equal(vault.slots.get(WSP_A), 'rt_a');
  assert.equal(s.workspaceId, WSP_B);
});

test('signOut is the only path that clears the vault, and clears every workspace', async () => {
  const vault = fakeVault();
  await vault.store(WSP_A, 'rt_a');
  await vault.store(WSP_B, 'rt_b');
  const s = new Session(deps({ vault }));
  await offline(() => s.signOut([WSP_A, WSP_B]));
  // Signing out of an account signs out of all of it, not just the one on screen.
  assert.deepEqual(vault.cleared.toSorted(), [WSP_A, WSP_B]);
  assert.equal(vault.slots.size, 0);
  assert.equal(s.state.status, 'signed_out');
  assert.equal(s.accessToken, null);
});

test('sign-in failure returns to signed_out without wiping stored state', async () => {
  const vault = fakeVault();
  await vault.store(WSP_A, 'rt_existing');
  const s = new Session(deps({
    vault,
    openBrowser: () => { throw new Error('browser unavailable'); },
  }));
  await assert.rejects(s.signIn(), /browser unavailable/);
  assert.equal(s.state.status, 'signed_out');
  assert.equal(vault.slots.get(WSP_A), 'rt_existing');
});

test('state changes are observable', async () => {
  const seen: string[] = [];
  const s = new Session(deps({ vault: fakeVault() }));
  s.onChange((st) => seen.push(st.status));
  await s.signOut([]);
  assert.deepEqual(seen, ['signed_out']);
});
