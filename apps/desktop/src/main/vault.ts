// Encrypted-at-rest storage for the refresh token, backed by the OS keychain
// via Electron's safeStorage (Keychain / DPAPI / libsecret).
//
// This lives in MAIN, not the sync process, for a measured reason: safeStorage
// is NOT exposed to a utilityProcess. Verified — a utilityProcess sees only
// `net` and `systemPreferences` from the electron module.
//
// That does not weaken the rule in DESIGN.md §13.1. The rule is that tokens
// never reach the RENDERER. Main is trusted; the renderer is the boundary,
// because it is the surface that runs remote-ish content and (later) a
// swappable UI bundle.
import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const file = () => join(app.getPath('userData'), 'auth', 'refresh.bin');

export const isEncryptionAvailable = (): boolean => safeStorage.isEncryptionAvailable();

export function storeRefreshToken(token: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    // Writing a bearer credential in plaintext is worse than not persisting it:
    // the user re-authenticates, rather than silently leaving a token readable
    // by anything on the machine.
    throw new Error('OS keychain unavailable — refusing to persist a token unencrypted');
  }
  const path = file();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, safeStorage.encryptString(token), { mode: 0o600 });
}

export function readRefreshToken(): string | null {
  const path = file();
  if (!existsSync(path)) return null;
  try {
    return safeStorage.decryptString(readFileSync(path));
  } catch {
    // A keychain that cannot decrypt its own blob means the entry is gone or
    // the machine changed. Treat as signed-out; never as data loss.
    return null;
  }
}

export function clearRefreshToken(): void {
  rmSync(file(), { force: true });
}
