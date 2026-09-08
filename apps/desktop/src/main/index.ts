// Main process: windows, lifecycle, and brokering the renderer <-> sync-engine
// handshake. Deliberately thin — it does NOT own the database or the socket
// (DESIGN.md §5).
import { app, BrowserWindow, ipcMain, utilityProcess, MessageChannelMain } from 'electron';
import { join } from 'node:path';
import { emit } from '@relayed/telemetry';

const bootStarted = Date.now();
let syncProcess: Electron.UtilityProcess | null = null;

function startSyncEngine(): Electron.UtilityProcess {
  const child = utilityProcess.fork(join(__dirname, 'sync.js'), [], {
    env: { ...process.env, RELAYED_DB: join(app.getPath('userData'), 'relayed.db') },
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

app.whenReady().then(() => {
  syncProcess = startSyncEngine();

  // The handshake. A MessagePort does NOT survive a renderer reload, so the
  // renderer asks for one on every load and main mints a fresh channel. Main
  // brokers this once and is then out of the hot path entirely (§5).
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
