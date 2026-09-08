// `relayed://` protocol handling — how the OAuth callback gets back into the
// app (PHASE-1-IDENTITY.md §6).
//
// The flow deliberately uses the system browser (RFC 8252), so the redirect
// lands on the OS, which hands it to a NEW instance of the app. The
// single-instance lock in index.ts is what makes that new process forward the
// URL and exit rather than becoming a rival instance.
import { app } from 'electron';

const SCHEME = 'relayed';

type Handler = (url: URL) => void;
let handler: Handler | null = null;

// A cold start via deep link delivers the URL BEFORE `whenReady` resolves on
// macOS, so callbacks must be buffered rather than dropped. This is the case
// that only shows up when the app is not already running — i.e. a real user's
// first sign-in, and never in a dev loop where the app is always up.
const pending: URL[] = [];

function deliver(raw: string | undefined): void {
  if (!raw) return;
  let url: URL;
  try { url = new URL(raw); } catch { return; }
  if (url.protocol !== `${SCHEME}:`) return;
  if (handler) handler(url); else pending.push(url);
}

/** Scan an argv for a relayed:// URL (Windows and Linux delivery path). */
const fromArgv = (argv: string[]): string | undefined =>
  argv.find(a => a.startsWith(`${SCHEME}://`));

export function registerProtocol(): boolean {
  // In development Electron runs unpackaged, so the OS would register the
  // Electron binary itself rather than our app. Passing execPath plus the app
  // path is what makes the registration point back at this project.
  const ok = app.isPackaged
    ? app.setAsDefaultProtocolClient(SCHEME)
    : app.setAsDefaultProtocolClient(SCHEME, process.execPath, [app.getAppPath()]);

  // macOS: the OS delivers via an event, whether or not the app was running.
  app.on('open-url', (event, url) => { event.preventDefault(); deliver(url); });

  // Windows / Linux: a second launch carries the URL in argv, and the
  // single-instance lock hands it to the running process.
  app.on('second-instance', (_event, argv) => { deliver(fromArgv(argv)); });

  // Cold start on Windows/Linux: the URL is in our own argv.
  deliver(fromArgv(process.argv));
  return ok;
}

/** Register the callback sink and flush anything that arrived before it. */
export function onDeepLink(cb: Handler): void {
  handler = cb;
  while (pending.length) { const u = pending.shift(); if (u) cb(u); }
}

export const isRegistered = (): boolean => app.isDefaultProtocolClient(SCHEME);
