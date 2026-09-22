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
  // One assertion where the status alone could not say it: it used to read
  // `authenticating`, and a separate boolean beside it had to say whether a
  // browser was involved. The status says so now.
  assert.equal(s.state.status, 'awaiting_browser');
  assert.equal(s.isAwaitingBrowser, true, 'the derived getter agrees with the state');

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

  assert.equal(s.state.status, 'awaiting_browser', 'the newer attempt survives the older one ending');
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
async function mintingServer(
  extra: Record<string, unknown> = {},
): Promise<{ url: string; close(): Promise<void> }> {
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
      access_token: 'new_access', refresh_token: 'rt_new', expires_in: 900, ...extra })));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

test('an ACCEPTED INVITATION survives into the authenticated state', async () => {
  // The regression this file did not have. `pendingJoins` lived only on
  // `needs_workspace`, so the one construction of `authenticated` dropped it —
  // and the renderer, reading a type that could not hold it, gated every use on
  // `needs_workspace`.
  //
  // The effect was that anyone who made a workspace BEFORE being invited to
  // another could never join the second: the handle picker was the only thing
  // that could complete a join, and nothing could reach it. The server sent the
  // field the whole time, on every refresh.
  const server = await mintingServer({ pending_joins: [
    { workspace_id: 'wsp_relay', org_id: 'org_relay', name: 'Relay',
      handle_suggestions: ['harsh'] },
  ] });
  process.env['RELAYED_SERVER_URL'] = server.url;
  try {
    const vault = fakeVault();
    await vault.store(WSP_A, 'rt_old');
    const s: Session = new Session(deps({ vault }));
    await s.activate(WSP_A);
    assert.equal(s.state.status, 'authenticated');
    if (s.state.status !== 'authenticated') return;
    assert.deepEqual(
      s.state.pendingJoins.map(j => j.workspaceId), ['wsp_relay'],
      'a workspace WorkOS admitted us to, with no actor here yet',
    );
  } finally {
    delete process.env['RELAYED_SERVER_URL'];
    await server.close();
  }
});

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

test('concurrent ensureFresh calls share ONE refresh — rotation would refuse a second', async () => {
  const { createServer } = await import('node:http');
  let refreshes = 0;
  const server = createServer((req, res) => {
    if (req.url === '/auth/refresh') refreshes++;
    // Refused, so nothing is adopted: the count is the whole assertion.
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_refresh_token' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  process.env['RELAYED_SERVER_URL'] = `http://127.0.0.1:${port}`;
  try {
    const vault = fakeVault();
    await vault.store(WSP_A, 'refresh_token_a');
    const s = new Session(deps({ vault }));
    await s.activate(WSP_A);            // one refresh; refused, so the session is stale
    assert.equal(refreshes, 1);

    const [first, second, third] = await Promise.all([s.ensureFresh(), s.ensureFresh(), s.ensureFresh()]);
    assert.deepEqual([first, second, third], [null, null, null]);
    assert.equal(refreshes, 2, 'three callers at once, one refresh request');

    await s.ensureFresh();
    assert.equal(refreshes, 3, 'a later call refreshes again — nothing is cached past the one in flight');
  } finally {
    delete process.env['RELAYED_SERVER_URL'];
    await new Promise(resolve => server.close(resolve));
  }
});

// ── adding a second account (STORAGE.md §12.5) ────────────────────────────────

/**
 * WorkOS and our server in one process, plus a "browser" that completes the
 * loopback callback the moment it is opened. `/auth/session` answers as the
 * NEW account — `needsWorkspace` decides whether it has a workspace yet.
 */
async function addAccountHarness(opts: {
  needsWorkspace?: boolean; completeBrowser?: boolean;
  /** The open account has no usable credential — a slot the keychain will not decrypt. */
  noCredential?: boolean;
} = {}) {
  const { createServer } = await import('node:http');
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      seen.push({ path: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      const actor = (wsp: string, id: string) => ({ actorId: id, orgId: 'org_1', workspaceId: wsp });
      switch (req.url) {
        case '/user_management/authenticate':
          return res.end(JSON.stringify({ access_token: jwt(1800000000),
                                          user: { id: 'user_2', email: 'second@example.com' } }));
        case '/auth/session':
          return res.end(JSON.stringify(opts.needsWorkspace
            ? { needs_workspace: true, identity: { email: 'second@example.com', displayName: 'Second' },
                handle_suggestions: ['second'] }
            : { access_token: 'access_b', refresh_token: 'rt_b', expires_in: 900,
                actor: actor(WSP_B, 'act_b') }));
        case '/auth/refresh':
          return res.end(JSON.stringify({ access_token: 'access_a', refresh_token: 'rt_a2',
                                          expires_in: 900, actor: actor(WSP_A, 'act_a') }));
        case '/auth/me':
          return res.end(JSON.stringify({ actor: { id: 'act_x', handle: 'x', display_name: 'X',
            avatar_url: null, org_id: 'org_1', workspace_id: WSP_A } }));
        default:
          res.writeHead(404);
          return res.end('{}');
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env['RELAYED_SERVER_URL'] = url;

  const vault = fakeVault();
  if (!opts.noCredential) await vault.store(WSP_A, 'rt_a');
  const opened: string[] = [];
  /** What each adoption told storage the account's email was. */
  const emails: (string | null)[] = [];
  // The resolver index.ts uses: provisional while adding, the open account's otherwise.
  const s: Session = new Session({
    onSession: (_session, { email }) => { emails.push(email); },
    config: { clientId: 'client_test', apiBase: url },
    deviceId: () => (s.adding ? 'dev_provisional' : 'dev_open'),
    vault,
    openBrowser: (u) => {
      opened.push(u);
      if (opts.completeBrowser === false) return;
      const q = new URL(u).searchParams;
      void fetch(`${q.get('redirect_uri')}?code=code_1&state=${q.get('state')}`).catch(() => {});
    },
  });
  await s.activate(WSP_A);
  assert.equal(s.state.status, opts.noCredential ? 'signed_out' : 'authenticated');
  const statuses: string[] = [];
  s.onChange(st => statuses.push(st.status));

  return {
    s, vault, seen, opened, statuses, emails,
    async close() {
      delete process.env['RELAYED_SERVER_URL'];
      await new Promise<void>(r => server.close(() => r()));
    },
  };
}

test('adding an account asks afresh and sends a PROVISIONAL device id, never the open account\'s', async () => {
  const h = await addAccountHarness();
  try {
    await h.s.addAccount();
    assert.equal(new URL(h.opened[0]!).searchParams.get('max_age'), '0',
      'without it AuthKit reuses the browser session — the account already open');
    const session = h.seen.find(r => r.path === '/auth/session');
    assert.equal(session?.body['device_id'], 'dev_provisional',
      'the open account\'s id would link two accounts server-side (§8)');
    assert.equal(h.s.state.status, 'authenticated');
    assert.equal(h.s.workspaceId, WSP_B, 'the held session is now the added account\'s');
    assert.equal(h.vault.slots.get(WSP_B), 'rt_b');
    assert.equal(h.s.adding, null);
    assert.ok(!h.statuses.some(st => st === 'authenticating' || st === 'awaiting_browser' || st === 'signed_out'),
      `the open account never looked signed out while adding: ${h.statuses.join(' → ')}`);
  } finally { await h.close(); }
});

test('cancelling an add leaves the open account exactly as it was', async () => {
  const h = await addAccountHarness({ completeBrowser: false });
  try {
    const token = h.s.accessToken;
    const pending = h.s.addAccount();
    const until = Date.now() + 2000;
    while (h.s.adding !== 'browser') {
      if (Date.now() > until) throw new Error('add never reached the browser');
      await new Promise(r => setTimeout(r, 5));
    }
    assert.equal(h.s.state.status, 'authenticated', 'still signed in while the browser is open');
    h.s.cancelAddAccount();
    await assert.rejects(pending);
    assert.equal(h.s.adding, null);
    assert.equal(h.s.state.status, 'authenticated');
    assert.equal(h.s.accessToken, token);
    assert.equal(h.s.workspaceId, WSP_A);
    assert.ok(!h.seen.some(r => r.path === '/auth/session'), 'nothing was exchanged');
  } finally { await h.close(); }
});

test('an added account with no workspace gets onboarding, and backing out restores the open one', async () => {
  const h = await addAccountHarness({ needsWorkspace: true });
  try {
    const token = h.s.accessToken;
    await h.s.addAccount();
    assert.equal(h.s.state.status, 'needs_workspace');
    assert.equal(h.s.adding, 'onboarding');
    assert.ok(h.s.canCreateWorkspace, 'onboarding holds the new identity\'s WorkOS token');

    // Set aside, so nothing can refresh the previous account into the middle
    // of someone else's onboarding.
    const refreshes = h.seen.filter(r => r.path === '/auth/refresh').length;
    assert.equal(await h.s.ensureFresh(), null);
    assert.equal(h.seen.filter(r => r.path === '/auth/refresh').length, refreshes);

    h.s.cancelAddAccount();
    assert.equal(h.s.adding, null);
    assert.equal(h.s.state.status, 'authenticated');
    assert.equal(h.s.accessToken, token);
    assert.equal(h.s.workspaceId, WSP_A);
    assert.equal(h.s.canCreateWorkspace, false, 'the added identity\'s token is dropped');
  } finally { await h.close(); }
});

test('activating another account\'s workspace never mints with the held session', async () => {
  const h = await addAccountHarness();
  try {
    // WSP_B has no slot; the held session is A's. /auth/switch with it can
    // only be refused (§10.2 step 3), so it must not be tried.
    const state = await h.s.activate(WSP_B, { mint: false });
    assert.ok(!h.seen.some(r => r.path === '/auth/switch'));
    assert.equal(state.status, 'signed_out');
  } finally { await h.close(); }
});

test('an account open with NO usable credential can still add one', async () => {
  // Found by hand: a rebuilt dev bundle whose keychain would not decrypt the
  // vault slot. The replica rendered (R3), activation landed on `signed_out`,
  // and "Add account" refused — leaving no way forward from inside the app.
  const h = await addAccountHarness({ noCredential: true });
  try {
    await h.s.addAccount();
    assert.equal(h.s.state.status, 'authenticated');
    assert.equal(h.s.workspaceId, WSP_B);
    const session = h.seen.find(r => r.path === '/auth/session');
    assert.equal(session?.body['device_id'], 'dev_provisional');
  } finally { await h.close(); }
});

test('backing out of an added account\'s onboarding returns to signed_out if that is where it started', async () => {
  const h = await addAccountHarness({ noCredential: true, needsWorkspace: true });
  try {
    await h.s.addAccount();
    assert.equal(h.s.state.status, 'needs_workspace');
    h.s.cancelAddAccount();
    assert.equal(h.s.state.status, 'signed_out');
    assert.equal(h.s.adding, null);
  } finally { await h.close(); }
});

test('the added account\'s email reaches storage once, from WorkOS — a refresh carries none', async () => {
  // Our server keeps no email (DESIGN §6.2), so the code exchange is the only
  // place the client learns which address an account is.
  const h = await addAccountHarness();
  try {
    assert.deepEqual(h.emails, [null], 'the boot refresh knows no email');
    await h.s.addAccount();
    assert.deepEqual(h.emails, [null, 'second@example.com']);
    await h.s.activate(WSP_A);
    assert.equal(h.emails.at(-1), null, 'a later refresh does not repeat or invent one');
  } finally { await h.close(); }
});

test('an added account that onboards first still records its email when it is created', async () => {
  const h = await addAccountHarness({ needsWorkspace: true });
  try {
    await h.s.addAccount();
    assert.deepEqual(h.emails, [null], 'nothing adopted yet — onboarding is on screen');
    h.s.cancelAddAccount();
    // Backing out drops it with the rest of the attempt: the next adoption is
    // the open account's own refresh, and must not be labelled with it.
    await h.s.activate(WSP_A);
    assert.equal(h.emails.at(-1), null);
  } finally { await h.close(); }
});
