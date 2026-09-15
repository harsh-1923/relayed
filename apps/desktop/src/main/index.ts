// Main process: windows, lifecycle, and brokering the renderer <-> sync-engine
// handshake. Deliberately thin — it does NOT own the database or the socket
// (DESIGN.md §5).
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, session, shell, utilityProcess,
  MessageChannelMain,
} from 'electron';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { emit, useOtlpIfConfigured } from '@relayed/telemetry';
import { registerProtocol, onDeepLink, isRegistered } from './deep-link';
import { registerBlobScheme, handleBlobProtocol, setBlobAccount } from './blob-protocol';
import { storeRefreshToken, readRefreshToken, clearRefreshToken, isEncryptionAvailable } from './vault';
import { guardWebPanels } from './web-panels';
import { clearSignIns, importCookies, listSources } from './browser-import';
import { isBrowserImportSourceId } from '../shared/browser-import.ts';
import { webPanelPartition } from '../shared/web-panels.ts';
import {
  buildMenuTemplate, defaultMenuItems, parseMenuItems, shouldIgnoreMenuShortcut, type NativeMenuItem,
} from './menu';
import type { NativeCommandId } from '../shared/shortcuts/catalogue.ts';
import { platformOf } from '../shared/shortcuts/tanstack-driver.ts';

// ── The application menu (SHORTCUTS.md §14; the reasoning is in menu.ts) ────
const menuPlatform = platformOf(process.platform);
/** Defaults until sync reports the open account's bindings over `shortcuts:menu`. */
let menuItems: NativeMenuItem[] = defaultMenuItems(menuPlatform);

/** A menu click becomes a command in the focused window, and only a command ID travels. */
function invokeCommand(id: NativeCommandId): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send('command:invoke', id);
}

function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(
    buildMenuTemplate(menuPlatform, menuItems, invokeCommand, app.name),
  ));
}

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

/**
 * Which development client this process is, if it is one of several.
 *
 * Sync is the first phase whose behaviour cannot be SEEN with one client, so a
 * dev loop has to be able to run two or three isolated installs against one
 * server (docs/MULTI-CLIENT-DEV.md). Isolation is entirely a matter of which
 * `userData` directory this process owns, because the whole storage layout —
 * account.db, the vault, every replica — hangs off that root (STORAGE.md §5).
 *
 * THE POSITION OF THIS BLOCK IS LOAD-BEARING, twice over.
 *
 * Before `requestSingleInstanceLock`, because that lock is keyed on the
 * userData directory. Without this, client 2 exits at startup having decided
 * client 1 is the same app — which is the guard working correctly, protecting a
 * database the second process was about to open behind the first one's back.
 *
 * And before anything reads `userData` at all, for the reason the comment above
 * records: the path used to be derived from `app.getName()` and silently changed
 * with how the app was launched. Setting it explicitly rather than letting a
 * name imply it is what keeps that closed.
 *
 * `!app.isPackaged` is not decoration. A shipped build must not be talkable into
 * a different database directory by an environment variable.
 */
const devClient = !app.isPackaged ? process.env['RELAYED_CLIENT'] : undefined;

/**
 * What this client calls itself: "Relayed 2", or plain "Relayed" when there is
 * only one.
 *
 * CHOSEN BY `scripts/dev-clients.mjs`, not derived here, because the same string
 * has to be stamped into the copy of `Electron.app` this process is running
 * from — `app.setName` is documented as changing the name used internally and
 * NOT the one the operating system shows, and on macOS the menu bar, the Dock
 * tile and the app switcher all read the running bundle's `CFBundleName`.
 * Deriving the name in two places is how the window and the menu bar come to
 * disagree about which client you are looking at.
 */
const clientName = devClient
  ? process.env['RELAYED_CLIENT_NAME'] || `Relayed ${devClient}`
  : 'Relayed';

if (devClient) {
  app.setName(clientName);
  const dir = join(app.getPath('appData'), `relayed-client-${devClient}`);
  // `setPath` requires a directory that already exists, and the failure would
  // land before any of our error handling.
  mkdirSync(dir, { recursive: true });
  app.setPath('userData', dir);
}

// Both MUST precede app.whenReady(); Electron ignores a privileged-scheme
// registration made after it (DESIGN.md §13.3).
registerBlobScheme();

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
let runnerProcess: Electron.UtilityProcess | null = null;
/** The open account, as the sync engine last said: whose session a web panel's page may use (web-panels.ts). */
let panelAccountId: string | null = null;

function startSyncEngine(): Electron.UtilityProcess {
  const child = utilityProcess.fork(join(__dirname, 'sync.js'), [], {
    // A DIRECTORY, not a file. The sync engine owns the layout beneath it and
    // decides which account and workspace to open (STORAGE.md §5, §11).
    //
    // The boot clock travels with it: main knows when the app started, the sync
    // engine knows whether there was local data to render. The R3 histogram
    // needs both, so the earlier of the two timestamps is passed along rather
    // than each process reporting half a number.
    env: {
      ...process.env,
      RELAYED_DATA: app.getPath('userData'),
      RELAYED_BOOT_T0: String(bootStarted),
      // Development tools — the simulated-offline switch, for one — exist only
      // in an unpackaged build. Absent from production rather than hidden in
      // it: a control that can disable the network has no business shipping,
      // even behind a flag nobody renders.
      ...(app.isPackaged ? {} : { RELAYED_DEV: '1' }),
    },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    // Crash isolation is a reason we chose a utilityProcess: respawn without
    // taking the app or the user's windows with it.
    if (code !== 0) setTimeout(() => { syncProcess = startSyncEngine(); }, 1000);
  });
  // A new sync engine has no port to the runner; a spawned child is the moment
  // it can take one.
  child.once('spawn', connectRunner);
  return child;
}

/**
 * The agent runner: the one process that talks to the person's Claude Code
 * (LOCAL-ROOMS.md §5). No database, no vault, no credential — it is given a
 * port to the sync engine and nothing else.
 *
 * Its environment is main's, and main's includes the development `.env`. That
 * is safe only because nothing reaches a Claude Code child except through
 * `claudeEnv`, which passes a short named list and nothing more.
 */
let runnerRestarts = 0;

function startAgentRunner(): Electron.UtilityProcess | null {
  const entry = join(__dirname, 'agent-runner.js');
  // Absent when a running `electron-vite dev` predates the entry being added to
  // its config, which it reads once at start. Said once rather than retried:
  // forking a missing file fails the same way every second, for ever.
  if (!existsSync(entry)) {
    console.warn('[main] no agent-runner.js in this build — restart `pnpm dev` to build it');
    return null;
  }
  const child = utilityProcess.fork(entry, [], {
    serviceName: 'Relayed agent runner',
    stdio: 'inherit',
  });
  child.once('spawn', () => {
    connectRunner();
    // Healthy for a while means a later crash starts the backoff afresh.
    setTimeout(() => { if (runnerProcess === child) runnerRestarts = 0; }, 60_000).unref();
  });
  child.on('exit', (code) => {
    if (runnerProcess === child) runnerProcess = null;
    if (code === 0) return;
    // Its Claude Code children die with it. That is survivable by design: a
    // conversation is resumed by session id, not by keeping a process alive.
    // Backed off, because a runner that crashes on start would otherwise spin.
    const delay = Math.min(1000 * 2 ** runnerRestarts++, 60_000);
    setTimeout(() => { runnerProcess = startAgentRunner(); }, delay).unref();
  });
  return child;
}

/**
 * A fresh channel between the sync engine and the runner.
 *
 * Called when either one spawns, so a restart of either gets a working pair
 * again without the other noticing anything but a replaced port. Main brokers
 * it and is then out of the path, as it is for the renderer.
 */
function connectRunner(): void {
  if (!syncProcess?.pid || !runnerProcess?.pid) return;
  const { port1, port2 } = new MessageChannelMain();
  runnerProcess.postMessage({ type: 'attach' }, [port1]);
  syncProcess.postMessage({ type: 'runner:attach' }, [port2]);
}

function createWindow(): BrowserWindow {
  // The native material is the full-window canvas. Renderer surfaces decide
  // where it remains visible; `transparent: true` is deliberately avoided
  // because Electron transparent windows lose normal resizing behavior.
  const windowBackground = process.platform === 'darwin'
    ? '#00000000'
    : nativeTheme.shouldUseDarkColors
      ? '#0a0a0a'
      : '#ffffff';

  const win = new BrowserWindow({
    width: 1000, height: 700, show: false,
    backgroundColor: windowBackground,
    // THE TOP BAR IS THE TITLE BAR. `hiddenInset` removes the bar and keeps the
    // traffic lights, so the strip they sit in is ours to paint — and ours to
    // mark draggable, which the renderer does with `-webkit-app-region`.
    //
    // `trafficLightPosition` is not cosmetic here: the default places the lights
    // for a standard-height title bar, which leaves them riding high in a 40px
    // one. These co-ordinates and that height are a pair — changing the bar's
    // height without changing this is how they end up half out of it.
    //
    // macOS only for now. Windows and Linux keep their own frame, so the bar
    // renders below it rather than replacing it: correct, just not yet the
    // whole idea.
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 13, y: 14 },
          vibrancy: 'menu' as const,
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,   // non-negotiable (§13.2)
      sandbox: true,
      nodeIntegration: false,
      // Web panels are `<webview>` elements; every attach is checked by guardWebPanels.
      webviewTag: true,
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
  // WHICH CLIENT THIS IS, in the window itself.
  //
  // The menu bar and the Dock say it too now, but they say it because
  // `scripts/dev-clients.mjs` stamps the name into a per-client copy of
  // `Electron.app` — nothing in this process can change either one. This stays
  // regardless: the title is what is in front of you at the moment you are
  // about to type into the wrong window, which the menu bar is not.
  //
  // Re-applied on `page-title-updated` because the renderer sets
  // `document.title`, and a marker that survives until the first route change is
  // a marker you cannot trust.
  if (devClient) {
    win.setTitle(clientName);
    win.on('page-title-updated', (event, title) => {
      event.preventDefault();
      win.setTitle(title.startsWith(clientName) ? title : `${clientName} — ${title}`);
    });
  }

  // The renderer's command bus owns every Relayed shortcut; on macOS the menu
  // would also act on one, so it is told to ignore menu shortcuts for exactly
  // the key presses that match a Relayed item (menu.ts). Re-decided on every
  // input, which is how Electron documents `setIgnoreMenuShortcuts`.
  win.webContents.on('before-input-event', (_event, input) => {
    win.webContents.setIgnoreMenuShortcuts(shouldIgnoreMenuShortcut(input, menuPlatform, menuItems));
  });

  guardWebPanels(win, () => panelAccountId);

  win.once('ready-to-show', () => {
    win.show();
    emit('app.boot', { to_first_render: Date.now() - bootStarted, from_local: true });
  });

  // BOTH RETURN A PROMISE, and both reject on an ordinary failure — a dev server
  // that is not up yet, an ERR_ABORTED from a reload landing mid-navigation. Left
  // floating, that is an unhandled rejection in the MAIN process, which is the
  // one that takes the whole app with it. Reported rather than swallowed: a
  // window that never loads is otherwise a white rectangle with no explanation.
  const target = process.env['ELECTRON_RENDERER_URL'];
  const loading = target ? win.loadURL(target)
                         : win.loadFile(join(__dirname, '../renderer/index.html'));
  loading.catch((e: unknown) => {
    console.error('[main] window failed to load', (e as Error).message);
  });
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

// `.then` with no `.catch` is an unhandled rejection if anything in the body
// throws, and the body is the whole of startup.
app.whenReady().then(() => {
  // Native material and renderer tokens follow one source of truth.
  //
  // The STARTING value, not the final one: the sync engine sends the stored
  // preference over `theme:source` as soon as it has opened account.db
  // (PREFERENCES.md §9). Set here anyway, because that message races the first
  // paint and the system appearance is the right thing to be showing if it
  // loses — or if there is no account, or the engine never starts.
  nativeTheme.themeSource = 'system';
  // Before the first window, so there is never a moment with Electron's default
  // menu in place of the one that carries Relayed's items.
  installMenu();

  // Dev only, macOS only: unpackaged Electron shows its own icon in the Dock,
  // because the real one is baked into the .app bundle at package time. This
  // puts our icon there so `dev` looks like the shipped product. Packaged
  // builds must NOT take this path — the bundle's .icns is already correct and
  // resources/ does not exist at this path inside the asar.
  if (!app.isPackaged && process.platform === 'darwin') {
    const devIcon = join(__dirname, '../../resources/icon.png');
    if (existsSync(devIcon)) app.dock?.setIcon(devIcon);
  }

  handleBlobProtocol();
  syncProcess = startSyncEngine();
  runnerProcess = startAgentRunner();

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

  // Waking from sleep, forwarded because `powerMonitor` is a main-process API
  // and the socket lives in the utility process.
  //
  // Worth the hop rather than waiting for TCP to notice. After a lid closes,
  // the connection is dead and the operating system will not find out for
  // minutes — so a machine that has just woken is the only prompt signal there
  // is that the socket needs replacing (invariant 30). Without this the app
  // looks connected and silently receives nothing.
  // Two events, listed separately because Electron types each one and a union
  // matches no single overload. `unlock-screen` is here as well as `resume`
  // because a machine can wake without the lid ever having closed — the screen
  // locks, the network changes, and `resume` never fires.
  const wake = (): void => { syncProcess?.postMessage({ type: 'net:resume' }); };
  powerMonitor.on('resume', wake);
  powerMonitor.on('unlock-screen', wake);

  // The handshake. A MessagePort does NOT survive a renderer reload, so the
  // renderer asks for one on every load and main mints a fresh channel. Main
  // brokers this once and is then out of the hot path entirely (§5).
  // The vault lives here because safeStorage is unavailable in a
  // utilityProcess (see vault.ts). The sync engine owns the auth logic and
  // asks main only to persist and retrieve the refresh token.
  syncProcess.on('message', (m: unknown) => {
    const msg = m as {
      type?: string; rid?: number; token?: string; url?: string;
      accountId?: string; workspaceId?: string; source?: string; items?: unknown;
      sourceId?: unknown; directory?: unknown;
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
      // Which account's blobs may be served. Storage lives in the sync
      // process, so main is told rather than deriving it.
      // The same signal decides whose session a web panel may browse in.
      case 'blob:account':
        setBlobAccount(msg.accountId ?? null);
        panelAccountId = msg.accountId ?? null;
        reply(null);
        break;
      // The theme preference, applied (PREFERENCES.md §9). One value drives the
      // native material AND prefers-color-scheme in the renderer, so the CSS
      // tokens and the window's vibrancy cannot disagree — the renderer's
      // existing media-query listener does the rest with no new code.
      //
      // Anything but the three it accepts falls back to 'system': this arrives
      // over IPC, and a themeSource Electron does not recognise would throw
      // inside the bridge's try and leave the caller's reply to the catch.
      case 'theme:source':
        nativeTheme.themeSource =
          msg.source === 'dark' || msg.source === 'light' ? msg.source : 'system';
        reply(null);
        break;
      // The folder a local room is about (LOCAL-ROOMS.md §7). Always chosen by
      // the person, so this is the only way a directory enters one.
      // The open account's bindings for the menu's Relayed items, from the
      // preference rows only sync reads (SHORTCUTS.md §6.3). Validated because
      // it arrives over IPC; a malformed list leaves the menu as it was.
      case 'shortcuts:menu': {
        const items = parseMenuItems(msg.items);
        if (items) {
          menuItems = items;
          installMenu();
        }
        reply(null);
        break;
      }
      case 'dialog:folder': {
        const [win] = BrowserWindow.getAllWindows();
        const options: Electron.OpenDialogOptions = {
          title: 'Choose a folder for this room', properties: ['openDirectory', 'createDirectory'],
        };
        void (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options))
          .then(result => reply(result.canceled ? null : (result.filePaths[0] ?? null)))
          .catch(() => reply(null));
        break;
      }
      // Signing web panels in from a browser on this Mac (browser-import/).
      // Always into the open account's panel session — the one guardWebPanels
      // lets a page attach to — so an import can never land in another's.
      case 'browserImport:sources':
        reply(listSources());
        break;
      case 'browserImport:run': {
        const pages = panelAccountId ? session.fromPartition(webPanelPartition(panelAccountId)) : null;
        if (!isBrowserImportSourceId(msg.sourceId) || typeof msg.directory !== 'string') {
          reply({ ok: false, reason: 'unknownSource' });
          break;
        }
        void importCookies({ sourceId: msg.sourceId, directory: msg.directory }, pages).then(reply);
        break;
      }
      case 'browserImport:clear': {
        const pages = panelAccountId ? session.fromPartition(webPanelPartition(panelAccountId)) : null;
        void clearSignIns(pages).then(() => reply(null), () => reply(null));
        break;
      }
      // Full Disk Access cannot be asked for; the person grants it, so open the pane where they do.
      case 'browserImport:fullDiskAccess':
        void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
        reply(null);
        break;
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
}).catch((e: unknown) => {
  // Startup failed. There is no window to show this in and no renderer to send
  // it to, so the log is the only place it can go — and exiting is honest:
  // a main process that survived a failed boot is an app with no windows and
  // no way to make one.
  console.error('[main] startup failed', (e as Error).message);
  app.exit(1);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

} // end single-instance guard
