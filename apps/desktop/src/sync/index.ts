// The sync engine. Runs as an Electron utilityProcess (DESIGN.md §5): it owns
// the databases and — from Phase 2 — the WebSocket. Deliberately not the main
// process, because node:sqlite is synchronous and a catch-up batch would stall
// the UI; and deliberately not the renderer, which would make R2 impossible.
//
// Verified in Phase 0: timers here are NOT subject to Chromium's renderer
// throttling (§13.9), which is what protects the 30s heartbeat.
//
// Storage is tiered (STORAGE.md §5): one account.db per account, one replica
// per workspace beneath it, exactly one workspace active at a time.
import { emit, count, histogram, span, useOtlpIfConfigured } from '@relayed/telemetry';
import { Session, type AuthState } from './auth/session.ts';
import { vault as bridgeVault, openBrowser, setBlobAccount } from './main-bridge.ts';
import { prefetchAvatars } from './blobs.ts';
import { Storage, type WorkspaceRow } from './storage.ts';
import { newId } from './ids.ts';
import type { OurSession } from './auth/relayed.ts';

interface Request { id: number; op: string; params?: unknown }
type Reply =
  | { id: number; ok: true; data: unknown; epoch: number }
  | { id: number; ok: false; error: string; epoch: number };

useOtlpIfConfigured('desktop');

/**
 * R3, asserted rather than observed (STORAGE.md §17.4, OBSERVABILITY.md §9).
 *
 * "It rendered on a plane" is a story; a count of network calls made before the
 * renderer could paint is a fact. Counting here, in the process that owns every
 * outbound request, is the only place the number can be trusted.
 *
 * Always on, not behind the verify flag: an invariant that is only checked when
 * someone remembers to check it is not instrumented. The URL list stays behind
 * `RELAYED_VERIFY_BOOT=1`, because that is a debugging aid rather than a signal.
 */
let paintable = false;
const bootCalls: string[] = [];
const traceCalls = Boolean(process.env['RELAYED_VERIFY_BOOT']);
{
  const real = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    if (!paintable) {
      count('boot.network_calls_before_paint');
      if (traceCalls) {
        const [input] = args;
        bootCalls.push(input instanceof Request ? input.url : String(input));
      }
    }
    return real(...args);
  }) as typeof fetch;
}

const storage = new Storage(process.env['RELAYED_DATA'] ?? process.cwd());
const boot = storage.boot();

// What multi-account and multi-workspace were built on assumptions about.
// Sampled at boot because that is when both are known without extra work.
histogram('boot.accounts', boot.accounts.length);
histogram('boot.workspaces', storage.accountId ? storage.workspaces().length : 0);

/**
 * Used only until we know which account this sign-in lands in.
 *
 * A re-authentication of the account we are already looking at reuses ITS
 * device_id, so it does not register as a new device. The gap: re-authenticating
 * some OTHER existing account — after a keychain reset, say — cannot be
 * recognised before the memberships come back, so it adopts this provisional id
 * and leaves the account's previous device row stale. Rare, revocable, and the
 * alternative is an extra round trip on every sign-in.
 *
 * Regenerated once an account adopts it. Held as a process-wide constant it
 * would be handed to the NEXT account created in the same run — so signing out
 * and signing in as a different email would give two accounts one device
 * identity, which is the correlation invariant 38 exists to prevent.
 */
let provisional: string | null = null;
const provisionalDeviceId = (): string => (provisional ??= newId('dev'));

/** Live renderer ports. Multiple windows are normal; dead ones must be reaped. */
const ports = new Set<Electron.MessagePortMain>();

const session = new Session({
  config: { clientId: process.env['WORKOS_CLIENT_ID'] ?? '' },
  deviceId: () => (storage.accountId ? storage.deviceId : provisionalDeviceId()),
  openBrowser,
  vault: {
    read: (wsp) => storage.accountId
      ? bridgeVault.read(storage.accountId, wsp)
      : Promise.resolve(null),
    store: (wsp, token) => storage.accountId
      ? bridgeVault.store(storage.accountId, wsp, token)
      : Promise.resolve(),
    clear: (wsp) => storage.accountId
      ? bridgeVault.clear(storage.accountId, wsp)
      : Promise.resolve(),
  },
  onSession: (s) => adoptSession(s),
});

/**
 * Land a freshly minted session in storage, BEFORE its refresh token is
 * persisted — the vault slot lives under the account directory, which on a
 * first sign-in does not exist yet.
 *
 * Matching is on actor-id intersection, never on a WorkOS identifier: no Layer
 * 1 identity is written to disk (STORAGE.md §5).
 */
function adoptSession(s: OurSession): void {
  const workspaceId = s.actor?.workspaceId;
  if (!workspaceId) return;

  if (s.memberships.length > 0) {
    const matched = storage.findAccountByActors(s.memberships.map(m => m.actorId));
    if (matched) {
      storage.openAccount(matched);
    } else {
      storage.openAccount(storage.createAccount(provisionalDeviceId()));
      // Consumed. The next account created in this run gets its own.
      provisional = null;
    }
    storage.syncMemberships(s.memberships);
  } else if (!storage.accountId) {
    // /auth/switch returns no memberships — it is scoped to one workspace and
    // says nothing new about the others. It can only follow a session that
    // already opened an account, so this is unreachable in practice.
    return;
  }

  if (storage.workspaceId !== workspaceId) storage.switchWorkspace(workspaceId);

  // Scope the blob handler to whatever account is now open, then fill the
  // avatar cache. Fire-and-forget: a grey circle is not a failed sign-in.
  void setBlobAccount(storage.accountId);
  void fillAvatars();
}

/** §13.3: avatars are fetched eagerly, always. Failures are silent and retried. */
async function fillAvatars(): Promise<void> {
  if (await prefetchAvatars(storage) > 0) push();
}

// ── the view the renderer renders ───────────────────────────────────────────

function view() {
  const hasAccount = storage.accountId !== null;
  const workspaces: WorkspaceRow[] = hasAccount ? storage.workspaces() : [];
  return {
    installId: storage.installId,
    epoch: storage.epoch,
    accountId: storage.accountId,
    accounts: storage.accounts().map(a => ({
      accountId: a.accountId,
      workspaces: a.workspaces.filter(w => w.state === 'active').length,
      lastActiveAt: a.lastActiveAt,
    })),
    workspaceId: storage.workspaceId,
    workspaces,
    auth: session.state,
  };
}

function push(): void {
  const data = view();
  for (const p of ports) p.postMessage({ push: 'app:state', data });
}

session.onChange((_state: AuthState) => push());

// ── handlers ────────────────────────────────────────────────────────────────

const handlers: Record<string, (params?: unknown) => unknown | Promise<unknown>> = {
  ping: () => ({ pong: true, at: Date.now() }),
  'app.state': () => view(),
  'ports.live': () => ({ count: ports.size }),

  'db.info': () => {
    if (!storage.hasWorkspace) return { open: false };
    const db = storage.workspace;
    const uv = db.prepare('PRAGMA user_version').get() as { user_version: number };
    const av = db.prepare('SELECT * FROM pragma_auto_vacuum()').get() as Record<string, number>;
    const jm = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const tables = db.prepare(
      "SELECT count(*) c FROM sqlite_master WHERE type='table'").get() as { c: number };
    return {
      open: true,
      accountId: storage.accountId,
      workspaceId: storage.workspaceId,
      schemaVersion: uv.user_version,
      autoVacuum: Object.values(av)[0],
      journalMode: jm.journal_mode,
      tables: tables.c,
      sqlite: (db.prepare('select sqlite_version() v').get() as { v: string }).v,
      node: process.versions.node,
      pid: process.pid,
    };
  },

  // ── auth (PHASE-1-IDENTITY.md §7) ──────────────────────────────────────
  'auth.state': () => session.state,
  'auth.signIn': async () => {
    // Opens the SYSTEM browser and blocks on the loopback callback. The
    // renderer never sees a token — only the resulting state.
    await session.signIn(storage.workspaceId ?? undefined);
    push();
    return view();
  },
  'auth.signOut': async () => {
    const accountId = storage.accountId;
    const ids = accountId ? storage.workspaces().map(w => w.workspaceId) : [];

    // signOut() flips auth state, which pushes. That push necessarily describes
    // a half-finished sign-out: credentials gone, storage still on disk. The
    // authoritative push is the one at the end of this handler.
    await session.signOut(ids);

    // §13: sign-out wipes the database and blob directory. With this layout
    // that is one directory delete, which cannot be half-completed.
    if (accountId) storage.deleteAccount(accountId);
    void setBlobAccount(storage.accountId);

    // Another account may still be signed in on this device; boot picks it up.
    const next = storage.boot();
    if (next.workspaceId) void session.activate(next.workspaceId);

    push();
    return view();
  },
  'auth.createWorkspace': async (params) => {
    const p = params as { workspaceName: string; handle: string };
    // Onboarding holds a WorkOS token; a signed-in user creating an additional
    // workspace does not, and does not need one (§10.4).
    if (session.canCreateWorkspace) await session.createWorkspace(p.workspaceName, p.handle);
    else await session.createAnotherWorkspace(p.workspaceName, p.handle);
    push();
    return view();
  },
  'auth.configured': () => ({ clientId: (process.env['WORKOS_CLIENT_ID'] ?? '').slice(0, 14) || null }),

  /** Everything on disk. Debug only — see Storage.debug(). */
  'debug.snapshot': () => storage.debug(),

  /**
   * Invariant 41, reported from the preload — the only place that knows a reply
   * was superseded. A small spike per switch is correct; a sustained rate means
   * the epoch is wrong and the UI is discarding work it should have shown.
   */
  'telemetry.staleDropped': () => { count('ipc.stale_dropped'); return null; },

  // ── workspaces (STORAGE.md §12.2) ──────────────────────────────────────
  'workspace.switch': (params) => {
    const { workspaceId } = params as { workspaceId: string };
    if (workspaceId === storage.workspaceId) return view();

    // Two phases, timed separately and deliberately (STORAGE.md §12.2).
    //
    // `local` is everything the user waits on: the durable write, closing one
    // replica, opening the next, and the repaint. It must stay flat.
    // `authorized` is the token and socket work that follows, is allowed to be
    // slow, and is unbounded when offline. One number covering both would hide
    // a regression in the half that matters.
    const t0 = performance.now();
    let result: 'ok' | 'error' = 'ok';
    try {
      // Step 3 closes the socket — none exists until Phase 2. Steps 2, 4 and 5
      // are storage's, and commit `last_workspace` before touching a handle.
      storage.switchWorkspace(workspaceId);
    } catch (e) {
      result = 'error';
      histogram('workspace.switch', Math.round(performance.now() - t0),
                { phase: 'local', result });
      throw e;
    }
    histogram('workspace.switch', Math.round(performance.now() - t0),
              { phase: 'local', result });

    // Step 7 is deliberately not awaited — a switch must complete offline, and
    // activate() resolves to `stale` rather than throwing when it cannot reach
    // the server.
    const t1 = performance.now();
    void span('workspace.authorize', () => session.activate(workspaceId))
      .then((state) => {
        histogram('workspace.switch', Math.round(performance.now() - t1),
                  { phase: 'authorized', result: state.status === 'stale' ? 'error' : 'ok' });
      });
    return view();
  },
};

function attach(port: Electron.MessagePortMain) {
  ports.add(port);
  port.on('message', (e: Electron.MessageEvent) => {
    const req = e.data as Request;
    void (async () => {
      let reply: Reply;
      try {
        const handler = handlers[req.op];
        if (!handler) throw new Error(`unknown op: ${req.op}`);
        reply = { id: req.id, ok: true, data: await handler(req.params), epoch: storage.epoch };
      } catch (err) {
        reply = { id: req.id, ok: false, error: (err as Error).message, epoch: storage.epoch };
      }
      // Every reply is stamped (invariant 41). A query issued against the
      // previous workspace can still be in flight when the switch lands, and
      // without this the renderer would paint it under the new workspace.
      port.postMessage(reply);
    })();
  });
  // A port dies when its renderer reloads or its window closes. Reaping is what
  // stops a leak across reloads (DESIGN.md §13.2).
  port.on('close', () => { ports.delete(port); });
  port.start();
  emit('sync.port.attached', { live_ports: ports.size });

  if (ports.size === 1) {
    // The renderer can paint the moment it holds a port, and syncing has not
    // been allowed to start yet — so anything counted before now is a real R3
    // violation. Closing the window here stops counting ordinary sync traffic.
    paintable = true;
    if (traceCalls) {
      console.log(JSON.stringify({
        verify: 'boot', networkCallsBeforeFirstPaint: bootCalls.length,
        calls: bootCalls,
        accountId: storage.accountId, workspaceId: storage.workspaceId,
        workspaces: storage.accountId ? storage.workspaces().length : 0,
      }));
    }
    startSyncing();
  }
}

/**
 * Sync starts only once the UI can paint (§11, step 7).
 *
 * Not merely un-awaited — deferred. An un-awaited restore would still open a
 * socket and a token request while the window is being created, which makes
 * "no network before first render" true by accident and unprovable by
 * measurement. Deferring it makes the ordering the code's, not the scheduler's.
 *
 * The timer is the fallback for a launch that never opens a window; whichever
 * comes first wins, and startSyncing is idempotent.
 */
let syncStarted = false;
function startSyncing(): void {
  if (syncStarted) return;
  syncStarted = true;
  void setBlobAccount(storage.accountId);
  if (boot.workspaceId) void session.activate(boot.workspaceId);
  // Boot may already hold everything but the bytes — an install whose blobs
  // were evicted, or a fetch that failed while offline last run.
  void fillAvatars();
}
setTimeout(startSyncing, 5_000).unref?.();

process.parentPort.on('message', (e) => {
  const [port] = e.ports;
  if (port) { attach(port); return; }
  const msg = e.data as { type?: string; url?: string };
  if (msg?.type === 'auth:callback' && msg.url) {
    // Phase 1: PKCE exchange lands here. Logging only for now — the point is
    // that the URL reached the process that owns the verifier.
    console.log(JSON.stringify({ phase1: 'callback-received', url: msg.url }));
  }
});
