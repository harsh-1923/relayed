// Importing another browser's signed-in sessions into web panels (docs/PANELS.md,
// browser import). In main because both halves are main's: the Keychain prompt
// names the process that asks, and the cookies go into an Electron session.
//
// The person starts every import from settings; nothing else calls this. The
// Keychain prompt macOS shows for a Chromium browser is the consent, and a
// declined prompt is an answer, not an error to retry.
import { homedir } from 'node:os';
import type { Session } from 'electron';
import type {
  BrowserImportFailure, BrowserImportResult, BrowserImportSource, BrowserImportSourceId,
} from '../../shared/browser-import.ts';
import { chromiumMacKey, CookieReadError, readChromiumCookies, readFirefoxCookies, readSafariCookies, type CookieRead } from './cookies.ts';
import { chromiumPid, cookieDatabase, listProfiles, SOURCES, unavailableReason, type SourceDefinition } from './sources.ts';

class ImportFailed extends Error {
  readonly reason: BrowserImportFailure;
  constructor(reason: BrowserImportFailure, options?: { cause?: unknown }) {
    super(`browser import failed: ${reason}`, options);
    this.reason = reason;
  }
}

export function listSources(home = homedir()): BrowserImportSource[] {
  return SOURCES.map(source => {
    const unavailable = unavailableReason(source, home);
    return {
      id: source.id,
      name: source.name,
      // Listing touches the browser's own files; skip it for one that cannot be imported anyway.
      profiles: unavailable === undefined ? listProfiles(source, home) : [],
      ...(unavailable === undefined ? {} : { unavailable }),
      // Only offered where the browser's own lock named a process we can
      // resolve; the screen must not show a button that cannot act.
      ...(unavailable === 'browserRunning' && chromiumPid(source, home) !== undefined ? { canQuit: true } : {}),
    };
  })
    // Not installed is not a choice; the screen lists what is on this Mac.
    .filter(source => source.unavailable !== 'notInstalled');
}

/**
 * The Chromium cookie key, read in-process rather than through
 * `/usr/bin/security`. macOS attributes the prompt, and the "Always Allow" it
 * offers, to the binary that asks: through the CLI the grant would go to a tool
 * every process on the Mac can run. Untimed, because the answer is a modal and a
 * timeout racing the person reads as "allowing did nothing".
 */
async function chromiumKey(source: SourceDefinition): Promise<Buffer> {
  if (!source.keychain) throw new ImportFailed('unsupportedPlatform');
  let keyring: typeof import('@napi-rs/keyring');
  try {
    keyring = await import('@napi-rs/keyring');
  } catch (cause) {
    throw new ImportFailed('keychainUnavailable', { cause });
  }
  let secret: string | null;
  try {
    secret = new keyring.Entry(source.keychain.service, source.keychain.account).getPassword();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    throw new ImportFailed(/no (matching )?entry|not found/i.test(message) ? 'keychainItemMissing' : 'needsKeychainApproval', { cause });
  }
  if (!secret) throw new ImportFailed('keychainItemMissing');
  return chromiumMacKey(secret);
}

async function read(source: SourceDefinition, file: string): Promise<CookieRead> {
  if (source.engine === 'chromium') {
    const key = await chromiumKey(source);
    return readChromiumCookies(file, key);
  }
  return source.engine === 'firefox' ? readFirefoxCookies(file) : readSafariCookies(file);
}

/**
 * One at a time: Chromium serialises cookie writes anyway, and a cookie the
 * store rejects should cost only itself. Flushed before reporting, so a crash
 * right after "Imported" does not lose what the person was just told.
 */
export async function writeCookies(session: Pick<Session, 'cookies'>, cookies: CookieRead): Promise<Extract<BrowserImportResult, { ok: true }>> {
  let imported = 0;
  let skipped = cookies.undecryptable;
  const sites = new Set(cookies.undecryptableHosts);
  const now = Date.now() / 1000;
  for (const cookie of cookies.cookies) {
    // Expired already: Chromium would drop it on write, and counting it as imported would lie.
    if (cookie.expirationDate !== undefined && cookie.expirationDate <= now) { skipped += 1; continue; }
    try {
      await session.cookies.set({
        url: cookie.url, name: cookie.name, value: cookie.value, path: cookie.path,
        secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
        ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
        ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
      });
      imported += 1;
    } catch {
      skipped += 1;
      try { sites.add(new URL(cookie.url).hostname); } catch { sites.add(cookie.url); }
    }
  }
  if (imported > 0) await session.cookies.flushStore().catch(() => { /* on disk at the next scheduled write */ });
  return { ok: true, imported, skipped, skippedSites: [...sites].slice(0, 20) };
}

export async function importCookies(
  input: { sourceId: BrowserImportSourceId; directory: string },
  session: Session | null,
  home = homedir(),
): Promise<BrowserImportResult> {
  try {
    if (!session) throw new ImportFailed('noAccount');
    const source = SOURCES.find(candidate => candidate.id === input.sourceId);
    if (!source) throw new ImportFailed('unknownSource');
    const blocked = unavailableReason(source, home);
    if (blocked) throw new ImportFailed(blocked);
    // The directory arrives over IPC, so it counts only if the browser listed
    // it: `..` in it would otherwise read any cookie database on the disk.
    const profile = listProfiles(source, home).find(candidate => candidate.directory === input.directory);
    if (!profile) throw new ImportFailed('unknownProfile');
    const file = cookieDatabase(source, home, profile.directory);
    if (!file) throw new ImportFailed('readFailed');
    return await writeCookies(session, await read(source, file));
  } catch (error) {
    if (error instanceof ImportFailed || error instanceof CookieReadError) return { ok: false, reason: error.reason };
    console.error('[browser-import] failed', error);
    return { ok: false, reason: 'readFailed' };
  }
}

/** Forget every site this account is signed in to inside web panels, imported or not. */
export async function clearSignIns(session: Session | null): Promise<void> {
  await session?.clearStorageData({ storages: ['cookies'] });
}
