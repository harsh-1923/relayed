// Web pages inside panels (docs/PANELS.md, web pages).
//
// A page is a `<webview>` in the window's own DOM, so CSS places it and the
// app's menus and dialogs draw over it like over anything else. Electron's
// guide prefers `WebContentsView`, but a native view sits above the whole
// window: every menu opened over a page would need the page hidden and a
// picture drawn in its place, and every move of the panel a message to main.
// t3code ships `<webview>` for the same job, which is the evidence it holds up.
//
// Enabling the tag means anything running in the window could create one, so
// every attach is checked here: the account's own partition, an http or https
// page, no preload, sandboxed. What the page can then do — open windows, leave
// http and https, ask for permissions — is decided here too, never in the page.
import { session, shell, type BrowserWindow, type Session, type WebContents } from 'electron';
import { isWebUrl, webPanelPartition } from '../shared/web-panels.ts';

/**
 * The one permission a page is granted: writing text to the clipboard, which the
 * copy buttons on a dev server's error page need. Everything else — camera,
 * microphone, location, notifications, reading the clipboard — is denied until
 * there is a reason to ask the person.
 */
const GRANTED = new Set(['clipboard-sanitized-write']);

const hardened = new WeakSet<Session>();

/** Once per session: what its pages are granted, and how they introduce themselves. */
function harden(pages: Session): void {
  if (hardened.has(pages)) return;
  hardened.add(pages);
  pages.setPermissionRequestHandler((_contents, permission, callback) => { callback(GRANTED.has(permission)); });
  pages.setPermissionCheckHandler((_contents, permission) => GRANTED.has(permission));
  // Without `Electron/`, which sites refuse outright, but keeping the app's own
  // `Relayed/<version>`. Removing that too made the agent claim to be Google
  // Chrome while Client Hints say plain Chromium, and Google's sign-in refuses
  // that mismatch as spoofing ("This browser or app may not be secure"). An app
  // that names itself, as t3code's preview does, is allowed to sign in.
  pages.setUserAgent(pages.getUserAgent().replace(/ Electron\/\S+/, ''));
  // Downloads need nothing here: with no save path set, Electron asks where to
  // save, so a page cannot write to disk without the person choosing a place.
}

/** A page attached to the window: kept to the web, and to the panel it is in. */
function guardPage(contents: WebContents): void {
  // A link that wants a new window goes to the system browser; the app opens none.
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // No frame reaches the app's own schemes or the disk, by link or by redirect.
  contents.on('will-frame-navigate', details => { if (!isWebUrl(details.url)) details.preventDefault(); });
  contents.on('will-redirect', details => { if (!isWebUrl(details.url)) details.preventDefault(); });
}

/**
 * Check every `<webview>` the window tries to attach, and guard the ones it may.
 * `accountId` is read at attach time: a page belongs to the account open then.
 */
export function guardWebPanels(window: BrowserWindow, accountId: () => string | null): void {
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const account = accountId();
    const partition = account ? webPanelPartition(account) : null;
    if (!partition || params['partition'] !== partition || !isWebUrl(params['src'])) {
      event.preventDefault();
      return;
    }
    // Before the page exists: a page takes its user agent from the session when it is made.
    harden(session.fromPartition(partition));
    // Whatever the tag asked for: nothing of the app's reachable from the page.
    delete webPreferences.preload;
    webPreferences.sandbox = true;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
  });
  window.webContents.on('did-attach-webview', (_event, contents) => { guardPage(contents); });
}
