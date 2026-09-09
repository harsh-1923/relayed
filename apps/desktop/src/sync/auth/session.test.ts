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

/**
 * Wait until a sign-in is genuinely waiting on a browser.
 *
 * `listenForCallback` binds a real socket, so a microtask tick is not enough —
 * assuming it was made these tests assert against a state that had not happened
 * yet, and one of them then sat on the five-minute loopback timeout.
 */
async function awaitingBrowser(s: Session, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!s.isAwaitingBrowser) {
    if (Date.now() > until) throw new Error('sign-in never reached the browser step');
    await new Promise(r => setTimeout(r, 5));
  }
}

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

test('a sign-in waiting on a browser can be abandoned', async () => {
  // The bug this exists for: closing the browser tab without signing in left
  // `authenticating` on screen for FIVE MINUTES — the loopback timeout — with a
  // disabled button and no way out. Reloading the window did not help, because
  // the attempt lives in the sync process.
  const vault = fakeVault();
  const s = new Session(deps({ vault, openBrowser: () => {} }));

  const inFlight = s.signIn().catch(() => {});
  await awaitingBrowser(s);
  assert.equal(s.state.status, 'authenticating');
  assert.equal(s.isAwaitingBrowser, true, 'there is something to cancel');

  assert.equal(s.cancelSignIn().status, 'signed_out');
  assert.equal(s.isAwaitingBrowser, false);
  await inFlight;                  // the listener closes, the attempt rejects
  assert.equal(s.state.status, 'signed_out', 'cancelling is final, not a race');
});

test('cancelling when nothing is in flight is harmless', () => {
  // A control that throws when pressed twice is its own bug.
  const s = new Session(deps({ vault: fakeVault() }));
  assert.equal(s.state.status, 'signed_out');
  assert.equal(s.cancelSignIn().status, 'signed_out');
  assert.equal(s.cancelSignIn().status, 'signed_out');
});

test('re-opening the browser reuses the SAME url', async () => {
  // A fresh url would mint a new PKCE challenge, and the listener already
  // running is bound to the old one — so "open the link again" would hand the
  // person a link that can never complete.
  const opened: string[] = [];
  const s = new Session(deps({ vault: fakeVault(), openBrowser: (u) => { opened.push(u); } }));

  const inFlight = s.signIn().catch(() => {});
  await awaitingBrowser(s);
  assert.equal(opened.length, 1);

  assert.equal(await s.reopenBrowser(), true);
  assert.equal(opened.length, 2);
  assert.equal(opened[1], opened[0], 'the second link must be the first link');

  s.cancelSignIn();
  await inFlight;
  assert.equal(await s.reopenBrowser(), false, 'nothing to re-open once abandoned');
});

test('starting again supersedes the attempt that was waiting', async () => {
  // Otherwise "try again" leaves the previous listener holding a port for five
  // minutes and two callbacks can race for one sign-in.
  const opened: string[] = [];
  const s = new Session(deps({ vault: fakeVault(), openBrowser: (u) => { opened.push(u); } }));

  const first = s.signIn().catch(() => {});
  await awaitingBrowser(s);
  const firstUrl = opened[0];

  const second = s.signIn().catch(() => {});
  await first;                          // superseded: its listener was closed
  await awaitingBrowser(s);

  assert.equal(s.state.status, 'authenticating', 'the newer attempt survives the older one ending');
  assert.notEqual(opened[1], firstUrl, 'a new attempt gets a new challenge and port');

  s.cancelSignIn();
  await second;
});

test('state changes are observable', async () => {
  const seen: string[] = [];
  const s = new Session(deps({ vault: fakeVault() }));
  s.onChange((st) => seen.push(st.status));
  await s.signOut([]);
  assert.deepEqual(seen, ['signed_out']);
});

/**
 * A server that mints a session, so the ADOPT path can be exercised at all.
 *
 * Everything above tests the paths that fail. Nothing tested the one that
 * succeeds, which is why the ordering below could regress unnoticed.
 */
async function mintingServer(): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/auth/me') {
      return res.end(JSON.stringify({ actor: {
        id: 'act_1', handle: 'harsh', display_name: 'Harsh', avatar_url: null,
        org_id: 'org_1', workspace_id: WSP_A } }));
    }
    req.on('data', () => {});
    req.on('end', () => res.end(JSON.stringify({
      access_token: 'new_access', refresh_token: 'rt_new', expires_in: 900 })));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

test('onSession sees the access token it is about to persist', async () => {
  // onSession lands the session in storage and then starts fillActors, which
  // reads `session.accessToken` and returns early if it is null. So a token
  // published AFTER this callback means the directory silently never syncs on
  // a first sign-in — no error, no log, just an empty directory.
  const server = await mintingServer();
  process.env['RELAYED_SERVER_URL'] = server.url;
  try {
    const vault = fakeVault();
    await vault.store(WSP_A, 'rt_old');
    let seen: string | null | undefined;
    const s: Session = new Session(deps({
      vault, onSession: () => { seen = s.accessToken; },
    }));
    await s.activate(WSP_A);
    assert.equal(s.state.status, 'authenticated');
    assert.equal(seen, 'new_access', 'the token must be readable from inside onSession');
  } finally {
    delete process.env['RELAYED_SERVER_URL'];
    await server.close();
  }
});
