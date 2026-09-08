// Main process: windows, lifecycle, and brokering the renderer <-> sync-engine
// handshake. Deliberately thin — it does NOT own the database or the socket
// (DESIGN.md §5).
import { app, BrowserWindow, ipcMain, nativeTheme, shell, utilityProcess, MessageChannelMain } from 'electron';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { emit, useOtlpIfConfigured } from '@relayed/telemetry';
import { registerProtocol, onDeepLink, isRegistered } from './deep-link';
import { storeRefreshToken, readRefreshToken, clearRefreshToken, isEncryptionAvailable } from './vault';

// MUST run before anything reads app.getPath('userData').
//
// userData is derived from app.getName(), which defaults to "Electron" for an
// unpackaged launch but to the package name under electron-vite — so the
// database path silently CHANGED depending on how the app was started, and we
// ended up with two of them. Pinning the name makes it deterministic.
//
// RELEASE.md §6: this name is permanent. Changing it orphans every existing
// user's local database — recoverable, since it is a replica, but
// indistinguishable from data loss to them.
app.setName('Relayed');

const bootStarted = Date.now();

// Development only: load repo-root .env so WORKOS_CLIENT_ID reaches the sync
// process. Packaged builds get configuration from the build, never from a file
// next to the app — a .env shipped beside a binary is a credential leak.
if (!app.isPackaged) {
  // Walk up looking for the repo-root .env. Counting `..` is fragile here:
  // app.getAppPath() resolves differently depending on how Electron was
  // launched (out/main when given a script path, the package root under
  // electron-vite dev).
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) { process.loadEnvFile(candidate); break; }
    dir = dirname(dir);
  }
}
let syncProcess: Electron.UtilityProcess | null = null;

function startSyncEngine(): Electron.UtilityProcess {
  const child = utilityProcess.fork(join(__dirname, 'sync.js'), [], {
    // A DIRECTORY, not a file. The sync engine owns the layout beneath it and
    // decides which account and workspace to open (STORAGE.md §5, §11).
    env: { ...process.env, RELAYED_DATA: app.getPath('userData') },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    // Crash isolation is a reason we chose a utilityProcess: respawn without
    // taking the app or the user's windows with it.
    if (code !== 0) setTimeout(() => { syncProcess = startSyncEngine(); }, 1000);
  });
  return child;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000, height: 700, show: false,
    // Paints before the renderer loads, so launch does not flash white.
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,   // non-negotiable (§13.2)
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Surface renderer errors in the main log during development; a silent CSP
  // violation or failed import is otherwise invisible outside devtools.
  if (!app.isPackaged) {
    win.webContents.on('console-message', (e) => {
      const t = typeof e === 'object' && e !== null && 'message' in e ? (e as { message: string }).message : String(e);
      if (/content security|refused|error/i.test(t)) console.warn('[renderer]', t.slice(0, 200));
    });
  }
  win.once('ready-to-show', () => {
    win.show();
    emit('app.boot', { to_first_render: Date.now() - bootStarted, from_local: true });
  });

  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

// Main emits its own events (app.boot), so it needs its own sink. Set up after
// the .env walk above, since the endpoint comes from there.
useOtlpIfConfigured('desktop');

// Exactly one instance. Without this a second launch starts a second app —
// two dock icons, two sync engines, and two writers against the same SQLite
// file, which is the part that actually corrupts things.
//
// It is also required for the `relayed://` auth callback (RELEASE.md §3): the
// OS hands the URL to a NEW process, which must forward it to the running one
// and exit rather than becoming a rival instance.
if (!app.requestSingleInstanceLock()) {
  console.warn('[main] another instance already holds the lock — exiting');
  app.quit();
} else {

app.on('second-instance', (_event, _argv) => {
  // TODO(Phase 1): _argv carries the relayed:// callback URL on Windows&Linux.
  const [win] = BrowserWindow.getAllWindows();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// Registered before whenReady so a cold start launched BY a relayed:// URL
// still buffers the callback instead of dropping it.
const protocolOk = registerProtocol();

app.whenReady().then(() => {
  // Match the renderer default so native chrome — the window frame, menus and
  // any OS-drawn control — is dark too, rather than a light frame around a
  // dark app.
  nativeTheme.themeSource = 'dark';

  syncProcess = startSyncEngine();

  onDeepLink((url) => {
    // Phase 1: the OAuth callback. Forwarded to the sync process, which owns
    // the PKCE verifier and does the token exchange — tokens never enter main
    // or the renderer (§6).
    if (url.host === 'auth' || url.pathname.startsWith('/auth')) {
      syncProcess?.postMessage({ type: 'auth:callback', url: url.toString() });
    }
    const [win] = BrowserWindow.getAllWindows();
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  if (process.env['RELAYED_VERIFY_DEEPLINK']) {
    console.log(JSON.stringify({ phase1: 'deeplink', registered: isRegistered(), setOk: protocolOk }));
  }

  // The handshake. A MessagePort does NOT survive a renderer reload, so the
  // renderer asks for one on every load and main mints a fresh channel. Main
  // brokers this once and is then out of the hot path entirely (§5).
  // The vault lives here because safeStorage is unavailable in a
  // utilityProcess (see vault.ts). The sync engine owns the auth logic and
  // asks main only to persist and retrieve the refresh token.
  syncProcess.on('message', (m: unknown) => {
    const msg = m as {
      type?: string; rid?: number; token?: string; url?: string;
      accountId?: string; workspaceId?: string;
    };
    const reply = (value: unknown) => syncProcess?.postMessage({ rid: msg.rid, value });
    // A vault slot is per (account, workspace) — STORAGE.md §9.
    const slot = (): [string, string] => {
      if (!msg.accountId || !msg.workspaceId) throw new Error('vault call without a slot');
      return [msg.accountId, msg.workspaceId];
    };

    try {
    switch (msg?.type) {
      case 'vault:read':  reply(readRefreshToken(...slot())); break;
      case 'vault:store': if (msg.token) storeRefreshToken(...slot(), msg.token); reply(null); break;
      case 'vault:clear': clearRefreshToken(...slot()); reply(null); break;
      case 'browser:open':
        // The SYSTEM browser, never a BrowserWindow — Google and Microsoft
        // refuse OAuth in embedded webviews (PHASE-1-IDENTITY.md §2).
        if (msg.url) void shell.openExternal(msg.url);
        reply(null);
        break;
      default: break;
    }
    } catch (e) {
      // A vault failure must not leave the sync engine waiting forever on a
      // reply that never comes — it degrades the session, it does not hang it.
      console.warn('[main] bridge call failed:', (e as Error).message);
      reply(null);
    }
  });

  if (!isEncryptionAvailable()) {
    console.warn('[main] OS keychain unavailable — sessions will not persist across restarts');
  }

  ipcMain.on('sync:attach', (event) => {
    if (!syncProcess) return;
    const { port1, port2 } = new MessageChannelMain();
    event.sender.postMessage('sync:port', null, [port1]);
    syncProcess.postMessage({ type: 'attach' }, [port2]);
  });

  const win = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Phase 0 verification of §16 open question 2: does a MessagePort re-handshake
  // cleanly across renderer reloads, or does it leak ports in the sync engine?
  // Env-gated so it never runs in a real session.
  //   RELAYED_VERIFY_RELOAD=12 pnpm start
  if (process.env['RELAYED_VERIFY_AUTH']) {
    void (async () => {
      const ask = (op: string) => new Promise((resolve) => {
        const { port1, port2 } = new MessageChannelMain();
        syncProcess!.postMessage({ type: 'attach' }, [port2]);
        port1.on('message', (e) => { port1.close(); resolve((e.data as { data: unknown }).data); });
        port1.start();
        port1.postMessage({ id: 1, op });
      });
      await new Promise((r) => setTimeout(r, 1500));
      console.log(JSON.stringify({ phase1: 'configured', ...(await ask('auth.configured') as object) }));
      console.log(JSON.stringify({ phase1: 'state', ...(await ask('auth.state') as object) }));
      app.exit(0);
    })();
  }

  if (process.env['RELAYED_VERIFY_RELOAD']) {
    const rounds = Number(process.env['RELAYED_VERIFY_RELOAD']);
    void (async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const live = async () => {
        const { port1, port2 } = new MessageChannelMain();
        syncProcess!.postMessage({ type: 'attach' }, [port2]);
        return await new Promise<number>((resolve) => {
          port1.on('message', (e) => {
            const n = (e.data as { data: { count: number } }).data.count;
            // Close the probe port, or the probes themselves accumulate and
            // masquerade as the leak we are testing for.
            port1.close();
            resolve(n);
          });
          port1.start();
          port1.postMessage({ id: 1, op: 'ports.live' });
        });
      };
      await sleep(2500);
      // The probe closes its own port, so this is the renderer count + 1 for
      // the in-flight probe.
      console.log(JSON.stringify({ phase0: 'reload', round: 0, livePorts: (await live()) - 1 }));
      for (let i = 1; i <= rounds; i++) {
        win.webContents.reload();
        await sleep(i % 4 === 0 ? 1200 : 350);   // mix rapid reloads with settled ones
        console.log(JSON.stringify({ phase0: 'reload', round: i, livePorts: (await live()) - 1 }));
      }
      await sleep(2000);
      console.log(JSON.stringify({ phase0: 'reload', round: 'final', livePorts: (await live()) - 1 }));
      app.exit(0);
    })();
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

} // end single-instance guard
