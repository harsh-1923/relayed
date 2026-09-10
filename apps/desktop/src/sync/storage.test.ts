import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Storage, type Membership, type DirectoryRow } from './storage.ts';
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
  // An empty outbox reads as 0 rather than as an error.
  storage.switchWorkspace('wsp_b');
  assert.equal(storage.workspaceRow('wsp_a')?.outboxHint, 0);

  // With rows in it, the real count. The table is the real one now — Phase 2
  // step A created it, so this no longer fabricates a two-column stand-in that
  // could drift from the schema it is standing in for.
  storage.switchWorkspace('wsp_a');
  storage.workspace.exec(`
    INSERT INTO outbox (op_id, seq, kind, chat_id, target_id, payload, created_at, state)
    VALUES ('o1',1,'send','c1','m1','{}',1,'queued'),
           ('o2',2,'send','c1','m2','{}',1,'inflight'),
           ('o3',3,'send','c1','m3','{}',1,'failed');`);
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


// ── the workspace directory ──────────────────────────────────────────────────
// None of this was covered, which is how a `DELETE FROM actors` on every sync
// survived long enough to make directory avatars permanently grey.

const dirRow = (over: Partial<DirectoryRow> & { id: string }): DirectoryRow => ({
  workspaceId: 'wsp_a', type: 'human', handle: 'someone', displayName: 'Some One',
  avatarUrl: null, ownerActorId: null, state: 'active', updatedAt: 1,
  ...over,
});

test('a directory sync keeps an avatar already fetched, and drops it when the url changes', () => {
  const dir = root();
  const { storage } = seeded(dir, [member({ workspaceId: 'wsp_a', actorId: 'act_a' })]);
  const url = 'https://cdn.example/face.png';
  const id = 'a'.repeat(64);

  storage.syncActors([dirRow({ id: 'act_a', avatarUrl: url })]);
  storage.putBlob(id, new TextEncoder().encode('PNG'));
  storage.setActorAvatarBlob('act_a', id);
  assert.equal(storage.actors()[0]?.avatarBlob, id);

  // The same directory again. The pointer must survive — the previous
  // implementation deleted every row first, so whatever the prefetch wrote was
  // gone by the next refresh and the fetch happened for ever with no effect.
  storage.syncActors([dirRow({ id: 'act_a', avatarUrl: url })]);
  assert.equal(storage.actors()[0]?.avatarBlob, id, 'an unchanged url keeps its bytes');

  // Negative control: a NEW url means the bytes we hold are the old face.
  storage.syncActors([dirRow({ id: 'act_a', avatarUrl: 'https://cdn.example/other.png' })]);
  assert.equal(storage.actors()[0]?.avatarBlob, null, 'a changed url must drop the pointer');
});

test('a directory sync removes actors the snapshot no longer contains', () => {
  const dir = root();
  const { storage } = seeded(dir, [member({ workspaceId: 'wsp_a', actorId: 'act_a' })]);

  storage.syncActors([dirRow({ id: 'act_a' }), dirRow({ id: 'act_b', handle: 'other' })]);
  assert.equal(storage.actors().length, 2);

  // Upsert replaced delete-then-insert, so removal is no longer free — it is a
  // second statement, and this is the test that says it still happens.
  storage.syncActors([dirRow({ id: 'act_a' })]);
  assert.deepEqual(storage.actors().map(a => a.id), ['act_a']);

  // The empty snapshot: an `IN ()` with no parameters is a syntax error in
  // SQLite, so this exercises the guard rather than the happy path.
  storage.syncActors([]);
  assert.equal(storage.actors().length, 0);
});

test('blobForUrl links bytes already held elsewhere, and ignores a pointer whose file is gone', () => {
  const dir = root();
  const url = 'https://cdn.example/face.png';
  const { storage, accountId } = seeded(dir, [member({
    workspaceId: 'wsp_a', actorId: 'act_a', actorAvatarUrl: url,
  })]);
  const id = 'a'.repeat(64);

  assert.equal(storage.blobForUrl(url), null, 'nothing held yet');

  storage.putBlob(id, new TextEncoder().encode('PNG'));
  storage.setAvatarBlob('wsp_a', 'actor', id);
  // The same person as "you" in account.db and as a directory row is one file.
  assert.equal(storage.blobForUrl(url), id, 'the same url anywhere is the same bytes');

  // A pointer to bytes that are gone is WORSE than no pointer: it renders as a
  // broken image where a monogram belongs.
  rmSync(join(dir, 'accounts', accountId, 'blobs', id.slice(0, 2), id));
  assert.equal(storage.blobForUrl(url), null, 'an evicted blob must not be linked');
});

// ─── welcome, applied ───────────────────────────────────────────────────────

const welcomePayload = (over: Partial<Parameters<Storage['applyWelcome']>[0]> = {}) => ({
  actorId: 'act_me',
  spaces: [{
    id: 'spc_eng', kind: 'channel', name: 'engineering', slug: 'engineering',
    visibility: 'public', membershipPolicy: 'open', lifecycle: 'active',
  }],
  chats: [{
    id: 'cht_eng', spaceId: 'spc_eng', kind: 'sole', name: null,
    headOrd: 5521, headRev: 8140,
    chatUnread: 6, threadUnread: 2, mentionCount: 1,
  }],
  memberships: [{ scopeType: 'space', scopeId: 'spc_eng', role: 'admin' }],
  ...over,
});

test('welcome makes every badge correct with NO messages held', () => {
  // R2, and the whole reason the frame carries head state rather than history.
  // "I have it" and "I know it exists" are different facts; only the second is
  // needed to render a number, and it costs one round trip instead of a
  // hundred thousand messages.
  const dir = root();
  const { storage } = seeded(dir, [member({ workspaceId: 'wsp_1', actorId: 'act_me' })]);
  storage.applyWelcome(welcomePayload());

  const db = new DatabaseSync(join(dir, 'accounts', storage.accountId!, 'workspaces', 'wsp_1', 'relayed.db'));
  const state = db.prepare('SELECT * FROM chat_state WHERE chat_id = ?').get('cht_eng') as
    Record<string, number>;
  assert.equal(state['chat_unread'], 6);
  assert.equal(state['mention_count'], 1);
  assert.equal(state['thread_unread'], 2);
  assert.equal(state['head_ord'], 5521);
  assert.equal(state['server_head_rev'], 8140);

  const messages = db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number };
  assert.equal(messages.n, 0, 'and not one message body was fetched');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('welcome does NOT advance the contiguity frontier', () => {
  // The sharpest rule in the client. `synced_through_rev` means "I hold every
  // change up to here, contiguously" — and being TOLD a head exists is not
  // holding the changes below it. Advancing it here would jump the frontier
  // past events that were never applied, which is a silent permanent hole
  // (invariant 1). The gap between the two watermarks IS the catch-up owed.
  const dir = root();
  const { storage } = seeded(dir, [member({ workspaceId: 'wsp_1', actorId: 'act_me' })]);
  storage.applyWelcome(welcomePayload());

  const db = new DatabaseSync(join(dir, 'accounts', storage.accountId!, 'workspaces', 'wsp_1', 'relayed.db'));
  const state = db.prepare('SELECT * FROM chat_state WHERE chat_id = ?').get('cht_eng') as
    Record<string, number>;
  assert.equal(state['synced_through_rev'], 0, 'nothing has been applied yet');
  assert.equal(state['server_head_rev'], 8140, 'but we know how much is owed');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a second welcome keeps the frontier and the gap marker it found', () => {
  // A reconnect must not undo progress. This frame knows what the SERVER holds
  // and nothing about what this device has applied, so it may only ever move
  // the server-side watermark.
  const dir = root();
  const { storage } = seeded(dir, [member({ workspaceId: 'wsp_1', actorId: 'act_me' })]);
  storage.applyWelcome(welcomePayload());

  const path = join(dir, 'accounts', storage.accountId!, 'workspaces', 'wsp_1', 'relayed.db');
  let db = new DatabaseSync(path);
  db.prepare('UPDATE chat_state SET synced_through_rev = ?, has_gap = 1, oldest_local_ord = ? WHERE chat_id = ?')
    .run(8100, 5000, 'cht_eng');
  db.close();

  storage.applyWelcome(welcomePayload({
    chats: [{
      id: 'cht_eng', spaceId: 'spc_eng', kind: 'sole', name: null,
      headOrd: 5600, headRev: 8200, chatUnread: 9, threadUnread: 0, mentionCount: 2,
    }],
  }));

  db = new DatabaseSync(path);
  const state = db.prepare('SELECT * FROM chat_state WHERE chat_id = ?').get('cht_eng') as
    Record<string, number>;
  assert.equal(state['synced_through_rev'], 8100, 'progress survived');
  assert.equal(state['has_gap'], 1, 'and so did the gap marker');
  assert.equal(state['oldest_local_ord'], 5000);
  assert.equal(state['server_head_rev'], 8200, 'while the head moved on');
  assert.equal(state['chat_unread'], 9);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a membership dropped from welcome is removed, not left stale', () => {
  // A stale grant would let the UI offer an action the server refuses — which
  // reads to the user as the app being broken rather than as them not being
  // allowed. The client may HIDE a permitted action; it may never permit a
  // denied one (invariant 49).
  const dir = root();
  const { storage } = seeded(dir, [member({ workspaceId: 'wsp_1', actorId: 'act_me' })]);
  storage.applyWelcome(welcomePayload({
    memberships: [
      { scopeType: 'space', scopeId: 'spc_eng', role: 'admin' },
      { scopeType: 'space', scopeId: 'spc_old', role: 'member' },
    ],
  }));

  storage.applyWelcome(welcomePayload());   // spc_old is gone

  const db = new DatabaseSync(join(dir, 'accounts', storage.accountId!, 'workspaces', 'wsp_1', 'relayed.db'));
  const rows = db.prepare('SELECT scope_id FROM memberships WHERE actor_id = ?')
    .all('act_me') as { scope_id: string }[];
  assert.deepEqual(rows.map(r => r.scope_id), ['spc_eng']);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('applying welcome is one transaction — a failure writes nothing', () => {
  // Half a welcome is worse than none: chats without their spaces render as
  // orphans, and badges without their chats are numbers attached to nothing.
  const dir = root();
  const { storage } = seeded(dir, [member({ workspaceId: 'wsp_1', actorId: 'act_me' })]);
  assert.throws(() => storage.applyWelcome(welcomePayload({
    chats: [{
      id: 'cht_orphan', spaceId: 'spc_missing', kind: 'sole', name: null,
      headOrd: 1, headRev: 1, chatUnread: 0, threadUnread: 0, mentionCount: 0,
    }],
  })));

  const db = new DatabaseSync(join(dir, 'accounts', storage.accountId!, 'workspaces', 'wsp_1', 'relayed.db'));
  const spaces = db.prepare('SELECT COUNT(*) n FROM spaces').get() as { n: number };
  assert.equal(spaces.n, 0, 'the space rolled back with the chat that failed');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
