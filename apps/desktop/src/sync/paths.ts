import { join } from 'node:path';

/**
 * Every path under userData, in one place (STORAGE.md §5).
 *
 *   userData/
 *     install-id                       telemetry only, NEVER in a token (§8)
 *     epoch                            monotonic switch counter, never reset
 *     accounts/<acc>/
 *       account.db                     device_id, workspace index
 *       auth/refresh-<wsp>.bin         one vault slot per workspace (§9)
 *       blobs/<2-char shard>/<id>      avatars — account tier, see below
 *       workspaces/<wsp>/
 *         relayed.db                   the replica — cursors, messages, outbox
 *         blobs/<2-char shard>/<id>
 *
 * The account directory is a locally generated `acc_…`, never the WorkOS user
 * id: a Layer 1 identifier in a filesystem path would let anyone with disk
 * access enumerate who has signed in on this machine (§6, §5).
 */
export const accountsDir  = (root: string) => join(root, 'accounts');
export const installIdFile = (root: string) => join(root, 'install-id');
/**
 * The workspace generation high-water mark, at the DEVICE tier.
 *
 * Deliberately not inside an account: signing out deletes the account
 * directory, and a counter that resets while a renderer still remembers the old
 * value makes every subsequent reply look stale (invariant 41).
 */
export const epochFile = (root: string) => join(root, 'epoch');

export const accountDir   = (root: string, acc: string) => join(accountsDir(root), acc);
export const accountDb    = (root: string, acc: string) => join(accountDir(root, acc), 'account.db');
export const authDir      = (root: string, acc: string) => join(accountDir(root, acc), 'auth');
export const vaultFile    = (root: string, acc: string, wsp: string) =>
  join(authDir(root, acc), `refresh-${wsp}.bin`);

/**
 * Avatars live at the ACCOUNT tier, not per workspace.
 *
 * DESIGN.md §13.3 predates the storage split and says `userData/blobs/`. Per
 * workspace would be the natural translation, except that the switcher draws an
 * avatar for every workspace including the ones you are not in — and the blob
 * handler resolves only within what is active (invariant 45). Account-tier is
 * the only placement where both hold. Message attachments stay per workspace,
 * where eviction follows the messages.
 */
export const accountBlobsDir = (root: string, acc: string) =>
  join(accountDir(root, acc), 'blobs');
/** Two-character shard: keeps directory entry counts sane on every filesystem. */
export const accountBlob = (root: string, acc: string, id: string) =>
  join(accountBlobsDir(root, acc), id.slice(0, 2), id);

export const workspacesDir = (root: string, acc: string) => join(accountDir(root, acc), 'workspaces');
export const workspaceDir  = (root: string, acc: string, wsp: string) =>
  join(workspacesDir(root, acc), wsp);
export const workspaceDb   = (root: string, acc: string, wsp: string) =>
  join(workspaceDir(root, acc, wsp), 'relayed.db');
export const blobsDir      = (root: string, acc: string, wsp: string) =>
  join(workspaceDir(root, acc, wsp), 'blobs');
