// `account.db`'s schema, executed (PREFERENCES.md §6).
//
// Same discipline as the replica half: a test per constraint, against a real
// engine, each asserted against an expected outcome. The failure being guarded
// is a CHECK that permits exactly the row it forbids, which passes any test
// that only exercises the happy path (DESIGN.md §13.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.ts';
import { migrate } from './migrate.ts';
import { accountMigrations } from './migrations/account.ts';
import { readPreferences, writePreference, clearPreference } from './prefs.ts';

function account(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'relayed-account-'));
  const db = openDatabase(join(dir, 'account.db'));
  migrate(db, accountMigrations);
  return db;
}

const put = (db: DatabaseSync, key: string, value: string, reach = 'local') =>
  db.prepare('INSERT INTO preferences (key, value, reach, updated_at) VALUES (?,?,?,?)')
    .run(key, value, reach, 1);

// ── the migration ───────────────────────────────────────────────────────────

test('the preferences table arrives, and auto_vacuum survives the migration', () => {
  const db = account();
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as
    { name: string }[]).map(r => r.name);
  assert.ok(names.includes('preferences'));
  assert.ok(names.includes('cached_assets'));
  // Invariant 11: the pragma is silently ignored if anything materialises the
  // header first, and the symptom appears months later on somebody else's disk.
  const row = db.prepare('SELECT * FROM pragma_auto_vacuum()').get() as Record<string, number>;
  assert.equal(Object.values(row)[0], 2, 'auto_vacuum is still incremental');
});

test('an EXISTING version 1 account upgrades, keeping its workspaces', () => {
  // The case that actually happens in the field: a reinstall replaces the app
  // and leaves userData intact, so new code always meets an old database.
  const dir = mkdtempSync(join(tmpdir(), 'relayed-account-upgrade-'));
  const file = join(dir, 'account.db');
  const first = openDatabase(file);
  migrate(first, accountMigrations.filter(m => m.version === 1));
  first.prepare(`INSERT INTO workspaces
    (workspace_id, org_id, name, slug, actor_id, actor_handle, actor_display_name, state)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run('wsp_1', 'org_1', 'Acme', 'acme', 'act_1', 'harsh', 'Harsh', 'active');
  first.close();

  const second = openDatabase(file);
  assert.deepEqual(migrate(second, accountMigrations),
                   { from: 1, to: 3, applied: ['2:preferences', '3:cached-assets'] });
  const kept = (second.prepare('SELECT name FROM workspaces').all() as { name: string }[])
    .map(r => ({ ...r }));
  assert.deepEqual(kept, [{ name: 'Acme' }]);
  // And the new table is usable on an upgraded file, not only a fresh one.
  writePreference(second, 'appearance.theme', 'dark');
  assert.equal(readPreferences(second).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('cached assets accept only named classes, sha256 ids and image media types', () => {
  const db = account();
  const insert = (kind: string | null, blobId: string, mediaType: string) => db.prepare(`
    INSERT INTO cached_assets (source_url, kind, blob_id, media_type, cached_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(`https://logos.test/${String(kind)}-${String(mediaType)}`, kind, blobId, mediaType, 1);

  insert('toolkit_logo', 'a'.repeat(64), 'image/svg+xml');
  assert.throws(() => insert('avatar', 'b'.repeat(64), 'image/png'), /kind/);
  assert.throws(() => insert('toolkit_logo', '../outside', 'image/png'), /blob_id/);
  assert.throws(() => insert('toolkit_logo', 'c'.repeat(64), 'text/html'), /media_type/);
  assert.throws(() => insert(null, 'd'.repeat(64), 'image/png'), /NOT NULL/);
});

// ── the constraints ─────────────────────────────────────────────────────────

test('a value must be JSON: "dark" is stored, bare dark is refused', () => {
  const db = account();
  put(db, 'a', '"dark"');
  put(db, 'b', '260');
  put(db, 'c', '{"mentions":true}');
  assert.equal(readPreferences(db).length, 3, 'scalars and objects both store');
  assert.throws(() => put(db, 'd', 'dark'), /json_valid/);
});

test('reach is a closed set', () => {
  const db = account();
  put(db, 'a', '"x"', 'synced');
  // 'device' was the earlier spelling of 'local' and is exactly the kind of
  // near-miss a closed set exists to catch.
  assert.throws(() => put(db, 'b', '"x"', 'device'), /reach/);
});

test('THE NULL TRAP: the CHECK alone would admit a null reach — NOT NULL is what refuses it', () => {
  const db = account();
  // The constraint as written on the table rejects it...
  assert.throws(() => put(db, 'a', '"x"', null as unknown as string), /NOT NULL/);

  // ...but through the NOT NULL, not the CHECK. Asserted rather than reasoned
  // about, because `NULL IN (...)` is NULL and a CHECK rejects only FALSE — so
  // the CHECK on its own permits exactly the row it appears to forbid. This
  // codebase has shipped that bug once already (DESIGN.md §13.5).
  db.exec(`CREATE TABLE probe (reach TEXT, CHECK (reach IN ('local','synced')))`);
  db.prepare('INSERT INTO probe VALUES (?)').run(null);
  assert.equal((db.prepare('SELECT count(*) c FROM probe').get() as { c: number }).c, 1,
               'the CHECK admitted a NULL, which is why NOT NULL is on the column');
});

test('a key holds one row: writing twice updates rather than accumulates', () => {
  const db = account();
  writePreference(db, 'appearance.theme', 'dark');
  writePreference(db, 'appearance.theme', 'light');
  assert.deepEqual(readPreferences(db),
                   [{ key: 'appearance.theme', value: '"light"', reach: 'local' }]);
});

test('reach is written from the catalogue, not by the caller', () => {
  const db = account();
  writePreference(db, 'appearance.theme', 'dark');
  assert.equal(readPreferences(db)[0]?.reach, 'local',
               'everything is local today (PREFERENCES.md §5)');
});

test('the store refuses what the catalogue does not allow', () => {
  const db = account();
  assert.throws(() => writePreference(db, 'appearance.mood', 'blue'), /unknown preference/);
  assert.throws(() => writePreference(db, 'appearance.theme', 'sepia'), /invalid value/);
  assert.throws(() => writePreference(db, 'appearance.theme', 42), /invalid value/);
  assert.equal(readPreferences(db).length, 0, 'nothing was written');
});

test('clearing returns a key to its default by REMOVING the row', () => {
  // Not by writing the default: a stored default would freeze today's answer
  // into every install that ever opened the screen (PREFERENCES.md §7).
  const db = account();
  writePreference(db, 'appearance.theme', 'dark');
  clearPreference(db, 'appearance.theme');
  assert.deepEqual(readPreferences(db), []);
});

test('a row this build does not understand is READ BACK, not dropped', () => {
  // The whole argument for a row per key (PREFERENCES.md §3). A client meeting
  // a key from a newer release must leave it alone — a client holding one JSON
  // document would read-modify-write it out of existence.
  const db = account();
  put(db, 'appearance.accent', '"violet"', 'synced');
  writePreference(db, 'appearance.theme', 'dark');
  assert.deepEqual(readPreferences(db).map(r => r.key),
                   ['appearance.accent', 'appearance.theme']);
});
