import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Storage, type Membership } from './storage.ts';
import { accountMigrations } from './migrations/account.ts';
import { workspaceMigrations } from './migrations/workspace.ts';

const root = () => mkdtempSync(join(tmpdir(), 'relayed-storage-'));

const member = (over: Partial<Membership> & { workspaceId: string; actorId: string }): Membership => ({
  orgId: 'org_1', name: 'Workspace', slug: 'workspace', workspaceAvatarUrl: null,
  actorHandle: 'harsh', actorDisplayName: 'Harsh Sharma', actorAvatarUrl: null,
  actorRole: 'owner',
  ...over,
});

/** A signed-in account with the given memberships, active on the first. */
function seeded(dir: string, memberships: Membership[], deviceId = 'dev_1') {
  const s = new Storage(dir);
  const acc = s.createAccount(deviceId);
  s.openAccount(acc);
  s.syncMemberships(memberships);
  if (memberships[0]) s.switchWorkspace(memberships[0].workspaceId);
  return { storage: s, accountId: acc };
}

test('install-id is generated once and then stable', () => {
  const dir = root();
  const first = new Storage(dir).installId;
  assert.match(first, /^ins_/);
  assert.equal(new Storage(dir).installId, first);
});

test('a fresh install boots with no account and no workspace', () => {
  const s = new Storage(root());
  const boot = s.boot();
  assert.deepEqual(boot.accounts, []);
  assert.equal(boot.accountId, null);
  assert.equal(boot.workspaceId, null);
  // The signed-out shell still has to render, so this must not throw.
  assert.equal(s.hasWorkspace, false);
});

test('device_id lives on the account, so two accounts get two of them', () => {
  const dir = root();
  const a = seeded(dir, [member({ workspaceId: 'wsp_a', actorId: 'act_a' })], 'dev_a');
  assert.equal(a.storage.deviceId, 'dev_a');
  a.storage.close();

  const s = new Storage(dir);
  const accB = s.createAccount('dev_b');
  s.openAccount(accB);
  assert.equal(s.deviceId, 'dev_b');

  s.openAccount(a.accountId);
  assert.equal(s.deviceId, 'dev_a', 'each account keeps its own device identity');
});

test('boot picks the most recently active account and its last workspace', () => {
  const dir = root();
  const a = seeded(dir, [member({ workspaceId: 'wsp_a', actorId: 'act_a' })], 'dev_a');
  a.storage.close();

  const b = seeded(dir, [
    member({ workspaceId: 'wsp_b1', actorId: 'act_b1' }),
    member({ workspaceId: 'wsp_b2', actorId: 'act_b2', name: 'Second' }),
  ], 'dev_b');
  b.storage.switchWorkspace('wsp_b2');
  b.storage.close();

  const boot = new Storage(dir).boot();
  assert.equal(boot.accounts.length, 2);
  assert.equal(boot.accountId, b.accountId, 'most recently active account wins');
  assert.equal(boot.workspaceId, 'wsp_b2', 'and its last_workspace, not merely its first');
});

test('an account is matched by actor-id intersection, never by a WorkOS id', () => {
  const dir = root();
  const { storage, accountId } = seeded(dir, [
    member({ workspaceId: 'wsp_a', actorId: 'act_a' }),
    member({ workspaceId: 'wsp_b', actorId: 'act_b' }),
  ]);
  storage.close();

  const s = new Storage(dir);
  // Signing in again returns the same actors — even a subset, which is what a
  // removal from one workspace looks like.
  assert.equal(s.findAccountByActors(['act_b']), accountId);
  assert.equal(s.findAccountByActors(['act_a', 'act_b']), accountId);
  // A different identity shares no actor id, so it must NOT match.
  assert.equal(s.findAccountByActors(['act_other']), null);
  assert.equal(s.findAccountByActors([]), null);

  // No WorkOS identifier is anywhere on disk (STORAGE.md §5).
  assert.ok(readdirSync(join(dir, 'accounts')).every(n => n.startsWith('acc_')));
});

test('a membership that disappears is marked removed, not deleted', () => {
  const { storage } = seeded(root(), [
    member({ workspaceId: 'wsp_a', actorId: 'act_a' }),
    member({ workspaceId: 'wsp_b', actorId: 'act_b' }),
  ]);
  assert.equal(storage.workspaces().length, 2);

  storage.syncMemberships([member({ workspaceId: 'wsp_a', actorId: 'act_a' })]);
  assert.equal(storage.workspaces().length, 1, 'only active workspaces are listed');
  assert.equal(storage.workspaceRow('wsp_b')?.state, 'removed', 'the row survives for the caller to act on');
});

test('a membership that comes back is reactivated', () => {
  const { storage } = seeded(root(), [member({ workspaceId: 'wsp_a', actorId: 'act_a' })]);
  storage.syncMemberships([member({ workspaceId: 'wsp_b', actorId: 'act_b' })]);
  assert.equal(storage.workspaceRow('wsp_a')?.state, 'removed');
  storage.syncMemberships([
    member({ workspaceId: 'wsp_a', actorId: 'act_a' }),
    member({ workspaceId: 'wsp_b', actorId: 'act_b' }),
  ]);
  assert.equal(storage.workspaceRow('wsp_a')?.state, 'active');
});

test('handles differ per workspace and are stored per workspace', () => {
  const { storage } = seeded(root(), [
    member({ workspaceId: 'wsp_a', actorId: 'act_a', actorHandle: 'harsh' }),
    member({ workspaceId: 'wsp_b', actorId: 'act_b', actorHandle: 'harsh.s', name: 'Acme Inc' }),
  ]);
  assert.equal(storage.workspaceRow('wsp_a')?.actorHandle, 'harsh');
  assert.equal(storage.workspaceRow('wsp_b')?.actorHandle, 'harsh.s');
});

test('each database carries its own user_version', () => {
  const dir = root();
  const { storage, accountId } = seeded(dir, [member({ workspaceId: 'wsp_a', actorId: 'act_a' })]);
  storage.close();

  const uv = (file: string) => {
    const db = new DatabaseSync(file, { readOnly: true });
    const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    db.close();
    return v;
  };
  // The point is that they advance INDEPENDENTLY, on their own version lines.
  assert.equal(uv(join(dir, 'accounts', accountId, 'account.db')), accountMigrations.at(-1)!.version);
  assert.equal(uv(join(dir, 'accounts', accountId, 'workspaces', 'wsp_a', 'relayed.db')),
               workspaceMigrations.at(-1)!.version);
});

test('auto_vacuum is INCREMENTAL on every workspace replica, not just the first', () => {
  // Invariant 11. The pragma is silently ignored if it does not run first, and
  // a new replica is created every time a workspace is opened for the first
  // time — so this has to hold for the tenth one as well.
  const { storage } = seeded(root(), [
    member({ workspaceId: 'wsp_a', actorId: 'act_a' }),
    member({ workspaceId: 'wsp_b', actorId: 'act_b' }),
    member({ workspaceId: 'wsp_c', actorId: 'act_c' }),
  ]);
  for (const wsp of ['wsp_a', 'wsp_b', 'wsp_c']) {
    storage.switchWorkspace(wsp);
    const row = storage.workspace.prepare('SELECT * FROM pragma_auto_vacuum()').get() as Record<string, number>;
    assert.equal(Object.values(row)[0], 2, `${wsp} must be INCREMENTAL`);
  }
});

test('the epoch is monotonic and survives a restart', () => {
  const dir = root();
  const { storage } = seeded(dir, [
    member({ workspaceId: 'wsp_a', actorId: 'act_a' }),
    member({ workspaceId: 'wsp_b', actorId: 'act_b' }),
  ]);
  const first = storage.epoch;
  storage.switchWorkspace('wsp_b');
  assert.equal(storage.epoch, first + 1);
  storage.close();

  // A counter that restarted at zero would let a reply minted before the
  // restart match after it (invariant 41).
  const after = new Storage(dir).boot();
  assert.equal(after.epoch, first + 1);
});

test('the epoch survives SIGNING OUT, which deletes the account', () => {
  // The reported bug. The counter lived in account.db, so sign-out wound it
  // back to zero while the renderer still remembered the old value — after
  // which every reply looked stale and surfaced as an error (invariant 41).
  const dir = root();
  const first = seeded(dir, [
    member({ workspaceId: 'wsp_a', actorId: 'act_a' }),
    member({ workspaceId: 'wsp_b', actorId: 'act_b' }),
  ]);
  first.storage.switchWorkspace('wsp_b');
  const high = first.storage.epoch;
  assert.ok(high > 0);

  first.storage.deleteAccount(first.accountId);
  assert.equal(first.storage.epoch, high, 'deleting an account must not wind it back');

  // Signing in again lands in a brand new account directory.
  const second = seeded(dir, [member({ workspaceId: 'wsp_c', actorId: 'act_c' })]);
  assert.ok(second.storage.epoch > high, 'and the next switch continues upward');
});

test('the epoch is seeded from the pre-device-tier per-account value', () => {
  // An install that already switched a few times must not restart below what a
  // live renderer remembers.
  const dir = root();
  const { storage, accountId } = seeded(dir, [member({ workspaceId: 'wsp_a', actorId: 'act_a' })]);
  storage.close();
  rmSync(join(dir, 'epoch'), { force: true });
  const db = new DatabaseSync(join(dir, 'accounts', accountId, 'account.db'));
  db.prepare("INSERT INTO meta(k,v) VALUES('epoch','7') ON CONFLICT(k) DO UPDATE SET v='7'").run();
  db.close();

  assert.equal(new Storage(dir).epoch, 7);
});

test('a switch commits last_workspace before touching a handle', () => {
  const dir = root();
  const { storage } = seeded(dir, [
    member({ workspaceId: 'wsp_a', actorId: 'act_a' }),
    member({ workspaceId: 'wsp_b', actorId: 'act_b' }),
  ]);
  storage.switchWorkspace('wsp_b');
  // Simulates a crash: nothing is closed cleanly, the process simply ends.
  const boot = new Storage(dir).boot();
  assert.equal(boot.workspaceId, 'wsp_b', 'reopens where the user was going, not where they left');
});

test('switching to an unknown or removed workspace is refused', () => {
  const { storage } = seeded(root(), [member({ workspaceId: 'wsp_a', actorId: 'act_a' })]);
  assert.throws(() => storage.switchWorkspace('wsp_nope'), /unknown workspace/);
  storage.syncMemberships([member({ workspaceId: 'wsp_b', actorId: 'act_b' })]);
  assert.throws(() => storage.switchWorkspace('wsp_a'), /workspace is removed/);
});

test('outbox_hint is written at close, and is zero before the write path exists', () => {
  const dir = root();
  const { storage } = seeded(dir, [
    member({ workspaceId: 'wsp_a', actorId: 'act_a' }),
    member({ workspaceId: 'wsp_b', actorId: 'act_b' }),
  ]);
  // The outbox table arrives with Phase 2; until then the count is honestly 0
  // rather than an error (STORAGE.md §16.1).
  storage.switchWorkspace('wsp_b');
  assert.equal(storage.workspaceRow('wsp_a')?.outboxHint, 0);

  // With a table present it records the real count.
  storage.switchWorkspace('wsp_a');
  storage.workspace.exec(`CREATE TABLE outbox (id TEXT PRIMARY KEY, state TEXT NOT NULL);
    INSERT INTO outbox VALUES ('o1','queued'), ('o2','queued'), ('o3','failed');`);
  storage.switchWorkspace('wsp_b');
  assert.equal(storage.workspaceRow('wsp_a')?.outboxHint, 2, 'failed rows are not pending work');
});

test('closing a workspace leaves no -wal or -shm behind', () => {
  const dir = root();
  const { storage, accountId } = seeded(dir, [member({ workspaceId: 'wsp_a', actorId: 'act_a' })]);
  storage.close();
  const wspDir = join(dir, 'accounts', accountId, 'workspaces', 'wsp_a');
  assert.ok(existsSync(join(wspDir, 'relayed.db')));
  assert.ok(!existsSync(join(wspDir, 'relayed.db-wal')), 'WAL must be checkpointed on close');
});

test('deleting an account removes its replicas, blobs and vault together', () => {
  const dir = root();
  const { storage, accountId } = seeded(dir, [member({ workspaceId: 'wsp_a', actorId: 'act_a' })]);
  const other = seeded(dir, [member({ workspaceId: 'wsp_z', actorId: 'act_z' })], 'dev_z');
  other.storage.close();

  writeFileSync(join(dir, 'accounts', accountId, 'auth', 'refresh-wsp_a.bin'), 'x');
  storage.deleteAccount(accountId);

  assert.ok(!existsSync(join(dir, 'accounts', accountId)), 'one directory delete takes all of it');
  assert.ok(existsSync(join(dir, 'accounts', other.accountId)), 'the other account is untouched');
  assert.equal(storage.accountId, null);
});

test('forgetting a workspace removes only that workspace', () => {
  const dir = root();
  const { storage, accountId } = seeded(dir, [
    member({ workspaceId: 'wsp_a', actorId: 'act_a' }),
    member({ workspaceId: 'wsp_b', actorId: 'act_b' }),
  ]);
  storage.switchWorkspace('wsp_b');
  storage.forgetWorkspace('wsp_a');
  const wsps = join(dir, 'accounts', accountId, 'workspaces');
  assert.ok(!existsSync(join(wsps, 'wsp_a')));
  assert.ok(existsSync(join(wsps, 'wsp_b')));
  assert.equal(storage.workspaceRow('wsp_a'), null);
});

test('an existing v1 account.db migrates its avatar columns in place', () => {
  const dir = root();
  const { storage, accountId } = seeded(dir, [
    member({ workspaceId: 'wsp_a', actorId: 'act_a', actorAvatarUrl: 'https://example.test/a.png' }),
  ]);
  storage.close();

  // Wind it back to the real v1 shape: one column, named avatar_blob, holding
  // what the server returned — which was a URL all along.
  const file = join(dir, 'accounts', accountId, 'account.db');
  const db = new DatabaseSync(file);
  db.exec('ALTER TABLE workspaces DROP COLUMN actor_role');
  db.exec('ALTER TABLE workspaces DROP COLUMN workspace_avatar_url');
  db.exec('ALTER TABLE workspaces DROP COLUMN workspace_avatar_blob');
  db.exec('ALTER TABLE workspaces DROP COLUMN actor_avatar_blob');
  db.exec('ALTER TABLE workspaces RENAME COLUMN actor_handle       TO handle');
  db.exec('ALTER TABLE workspaces RENAME COLUMN actor_display_name TO display_name');
  db.exec('ALTER TABLE workspaces RENAME COLUMN actor_avatar_url   TO avatar_blob');
  db.exec('PRAGMA user_version = 1');
  db.close();

  const reopened = new Storage(dir);
  reopened.openAccount(accountId);
  const row = reopened.workspaceRow('wsp_a');
  // v2 renames the column to what it actually holds, v3 adds the genuinely
  // local blob, v4 says whose each field is. The value survives all three.
  assert.equal(row?.actorAvatarUrl, 'https://example.test/a.png');
  assert.equal(row?.actorAvatarBlob, null);
  assert.equal(row?.actorHandle, 'harsh');
  assert.equal(row?.workspaceAvatarUrl, null, 'a workspace image is simply absent');
  // v5's default is the LEAST privilege, so a row that predates the column
  // grants nothing extra until the next membership refresh fills it in.
  assert.equal(row?.actorRole, 'member');
});

test('blobs are content-addressed, sharded, and account-tier', () => {
  const dir = root();
  const { storage, accountId } = seeded(dir, [member({ workspaceId: 'wsp_a', actorId: 'act_a' })]);
  const id = 'a'.repeat(64);
  assert.equal(storage.hasBlob(id), false);

  storage.putBlob(id, new TextEncoder().encode('PNGDATA'));
  assert.ok(storage.hasBlob(id));
  // Two-character shard, and under the ACCOUNT — not the workspace, because
  // the switcher draws avatars for workspaces that are not active (§13.3).
  const file = join(dir, 'accounts', accountId, 'blobs', 'aa', id);
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, 'utf8'), 'PNGDATA');

  storage.setAvatarBlob('wsp_a', 'actor', id);
  assert.equal(storage.workspaceRow('wsp_a')?.actorAvatarBlob, id);
  // The two subjects are separate columns and cannot be crossed.
  assert.equal(storage.workspaceRow('wsp_a')?.workspaceAvatarBlob, null);
});

test('a membership refresh keeps each blob unless ITS source URL changed', () => {
  const dir = root();
  const both = (actor: string, workspace: string) => member({
    workspaceId: 'wsp_a', actorId: 'act_a',
    actorAvatarUrl: actor, workspaceAvatarUrl: workspace,
  });
  const { storage } = seeded(dir, [both('https://cdn.test/me.png', 'https://cdn.test/ws.png')]);
  storage.setAvatarBlob('wsp_a', 'actor', 'b'.repeat(64));
  storage.setAvatarBlob('wsp_a', 'workspace', 'c'.repeat(64));

  // Same URLs: the bytes cannot have changed, so re-downloading on every
  // membership refresh would be pure waste.
  storage.syncMemberships([both('https://cdn.test/me.png', 'https://cdn.test/ws.png')]);
  assert.equal(storage.workspaceRow('wsp_a')?.actorAvatarBlob, 'b'.repeat(64));
  assert.equal(storage.workspaceRow('wsp_a')?.workspaceAvatarBlob, 'c'.repeat(64));

  // One changed: only that blob is dropped. The other is still the right image,
  // and re-fetching it would be work for nothing.
  storage.syncMemberships([both('https://cdn.test/NEW.png', 'https://cdn.test/ws.png')]);
  assert.equal(storage.workspaceRow('wsp_a')?.actorAvatarBlob, null);
  assert.equal(storage.workspaceRow('wsp_a')?.workspaceAvatarBlob, 'c'.repeat(64));
});

test('signing out takes the blobs with it', () => {
  const dir = root();
  const { storage, accountId } = seeded(dir, [member({ workspaceId: 'wsp_a', actorId: 'act_a' })]);
  storage.putBlob('c'.repeat(64), new TextEncoder().encode('bytes'));
  storage.deleteAccount(accountId);
  // §13: one directory delete takes replicas, vault AND blobs.
  assert.ok(!existsSync(join(dir, 'accounts', accountId)));
});

test('the debug tree shows our layout and hides Chromium runtime files', () => {
  const dir = root();
  // userData is shared with Chromium, which keeps a couple of hundred files
  // here. Listing them buries the handful that are ours.
  mkdirSync(join(dir, 'Cache', 'Cache_Data'), { recursive: true });
  writeFileSync(join(dir, 'Cache', 'Cache_Data', 'index'), 'x');
  writeFileSync(join(dir, 'Cache', 'Cache_Data', 'data_0'), 'x');
  writeFileSync(join(dir, 'Cookies'), 'x');

  const { storage } = seeded(dir, [
    member({ workspaceId: 'wsp_a', actorId: 'act_a' }),
    member({ workspaceId: 'wsp_b', actorId: 'act_b' }),
  ]);
  const snap = storage.debug();

  assert.deepEqual(snap.tree.map(n => n.name).toSorted(), ['accounts', 'epoch', 'install-id']);
  assert.equal(snap.hiddenFiles, 3, 'and says how many it left out');

  // A replica is created when its workspace is first OPENED, not when the
  // membership arrives — so a workspace you have never visited costs nothing.
  const wspsOf = (t: typeof snap) => {
    const accounts = t.tree.find(n => n.name === 'accounts')!;
    return accounts.children[0]!.children.find(n => n.name === 'workspaces')!
      .children.map(n => n.name).toSorted();
  };
  assert.deepEqual(wspsOf(snap), ['wsp_a'], 'wsp_b has never been opened');

  // Both are read once both exist, not just the active one — a workspace that
  // should have been deleted is invisible from the active handle alone.
  storage.switchWorkspace('wsp_b');
  const after = storage.debug();
  assert.deepEqual(wspsOf(after), ['wsp_a', 'wsp_b']);
  assert.equal(after.databases.filter(d => d.name.includes('wsp_')).length, 2);
  assert.ok(after.databases.every(d => d.autoVacuum === 2));
});

test('the debug snapshot lists vault slots by name and never their contents', () => {
  const dir = root();
  const { storage, accountId } = seeded(dir, [member({ workspaceId: 'wsp_a', actorId: 'act_a' })]);
  writeFileSync(join(dir, 'accounts', accountId, 'auth', 'refresh-wsp_a.bin'), 'SECRET');
  const snap = storage.debug();
  assert.deepEqual(snap.vaultSlots, [`${accountId}/refresh-wsp_a.bin`]);
  assert.ok(!JSON.stringify(snap).includes('SECRET'), 'a credential must never reach the renderer');
});

test('the pre-split layout is moved aside, not deleted', () => {
  const dir = root();
  // What Phase 1 left behind: one flat replica and one unkeyed vault slot.
  const legacy = new DatabaseSync(join(dir, 'relayed.db'));
  legacy.exec('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  legacy.close();
  mkdirSync(join(dir, 'auth'), { recursive: true });
  writeFileSync(join(dir, 'auth', 'refresh.bin'), 'opaque');

  new Storage(dir);
  assert.ok(!existsSync(join(dir, 'relayed.db')));
  assert.ok(existsSync(join(dir, 'relayed.db.pre-split')), 'a replica is recoverable, but not silently deleted');
  assert.ok(existsSync(join(dir, 'auth', 'refresh.bin.pre-split')));

  // Idempotent: a second boot must not fail on the already-present target.
  writeFileSync(join(dir, 'relayed.db'), 'again');
  new Storage(dir);
  assert.ok(!existsSync(join(dir, 'relayed.db')));
});
