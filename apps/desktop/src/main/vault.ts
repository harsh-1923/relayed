// Encrypted-at-rest storage for refresh tokens, backed by the OS keychain
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
//
// One slot per (account, workspace) — STORAGE.md §9. A session is per-actor
// (`sessions.actor_id`) and an actor is per-workspace, so a single unkeyed slot
// could only ever hold one workspace's credential.
import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// These ids reach us from the sync process and end up in a filesystem path.
// They are server-issued ULIDs, but validating the shape is what guarantees
// that — a traversal here would read or write outside the account directory.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function file(accountId: string, workspaceId: string): string {
  if (!ID.test(accountId) || !ID.test(workspaceId)) {
    throw new Error('vault: malformed account or workspace id');
  }
  return join(app.getPath('userData'), 'accounts', accountId, 'auth', `refresh-${workspaceId}.bin`);
}

export const isEncryptionAvailable = (): boolean => safeStorage.isEncryptionAvailable();

export function storeRefreshToken(accountId: string, workspaceId: string, token: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    // Writing a bearer credential in plaintext is worse than not persisting it:
    // the user re-authenticates, rather than silently leaving a token readable
    // by anything on the machine.
    throw new Error('OS keychain unavailable — refusing to persist a token unencrypted');
  }
  const path = file(accountId, workspaceId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, safeStorage.encryptString(token), { mode: 0o600 });
}

export function readRefreshToken(accountId: string, workspaceId: string): string | null {
  const path = file(accountId, workspaceId);
  if (!existsSync(path)) return null;
  try {
    return safeStorage.decryptString(readFileSync(path));
  } catch {
    // A keychain that cannot decrypt its own blob means the entry is gone or
    // the machine changed. Treat as signed-out; never as data loss.
    return null;
  }
}

export function clearRefreshToken(accountId: string, workspaceId: string): void {
  rmSync(file(accountId, workspaceId), { force: true });
}
