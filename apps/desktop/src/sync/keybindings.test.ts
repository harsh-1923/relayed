// Stored keybindings against a real, migrated account.db (SHORTCUTS.md §9, §15.4).
//
// The properties that matter are the ones a mock cannot show: that a refused
// batch leaves no row behind, that a clear is a DELETE, and that a value this
// build cannot read survives an unrelated write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.ts';
import { migrate } from './migrate.ts';
import { accountMigrations } from './migrations/account.ts';
import { applyPreferences, readPreferences, writePreference, KEYBINDING_CONFLICT, KEYBINDING_REFUSED } from './prefs.ts';
import { isKeybindingKey, isWritablePreferenceKey } from '../shared/prefs.ts';
import { resolveBindings } from '../shared/shortcuts/resolve.ts';

function account(): DatabaseSync {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'relayed-keybindings-')), 'account.db'));
  migrate(db, accountMigrations);
  return db;
}

const chord = (hotkey: string) => ({ kind: 'chord', hotkey });
const rows = (db: DatabaseSync) => Object.fromEntries(readPreferences(db).map(row => [row.key, row.value]));

/** What the renderer would dispatch from, read back out of the table. */
function effective(db: DatabaseSync) {
  const overrides = new Map<string, unknown>();
  for (const row of readPreferences(db)) {
    if (row.key.startsWith('keybindings.')) overrides.set(row.key.slice('keybindings.'.length), JSON.parse(row.value));
  }
  return Object.fromEntries(resolveBindings(overrides, 'mac').map(binding => [binding.id, binding]));
}

test('the keybinding family is closed over configurable commands', () => {
  assert.ok(isKeybindingKey('keybindings.app.search.open'));
  assert.ok(!isKeybindingKey('keybindings.app.teleport'));
  assert.ok(!isKeybindingKey('keybindings.'));
  assert.ok(!isKeybindingKey('app.search.open'));
  assert.ok(isWritablePreferenceKey('appearance.theme'));
  assert.ok(!isWritablePreferenceKey(42 as unknown as string), 'not a string');
});

test('a set stores canonical JSON for the writing platform, reach local', () => {
  const db = account();
  writePreference(db, 'keybindings.app.search.open', [chord('Cmd+Shift+p')], 'mac');
  assert.deepEqual(readPreferences(db), [{
    key: 'keybindings.app.search.open', value: '[{"kind":"chord","hotkey":"Mod+Shift+P"}]', reach: 'local',
  }]);
  assert.deepEqual(effective(db)['app.search.open']?.hotkeys, ['Mod+Shift+P']);
});

test('an empty list is stored and means disabled; a clear deletes and means default', () => {
  const db = account();
  applyPreferences(db, [{ op: 'set', key: 'keybindings.shell.sidebar.toggle', value: [] }], 'mac');
  assert.equal(effective(db)['shell.sidebar.toggle']?.source, 'disabled');
  applyPreferences(db, [{ op: 'clear', key: 'keybindings.shell.sidebar.toggle' }], 'mac');
  assert.deepEqual(readPreferences(db), [], 'reset removes the row rather than writing the default');
  assert.equal(effective(db)['shell.sidebar.toggle']?.source, 'default');
});

test('the engine refuses unknown commands, malformed values and missing platforms', () => {
  const db = account();
  assert.throws(() => applyPreferences(db, [{ op: 'set', key: 'keybindings.app.teleport', value: [] }], 'mac'), /unknown preference/);
  assert.throws(() => applyPreferences(db, [{ op: 'set', key: 'keybindings.app.search.open', value: ['Mod+K'] }], 'mac'), /invalid keybindings/);
  assert.throws(() => applyPreferences(db, [{ op: 'set', key: 'keybindings.app.search.open', value: [chord('Mod+Shift')] }], 'mac'), /invalid keybindings/);
  assert.throws(() => applyPreferences(db, [{ op: 'rename', key: 'keybindings.app.search.open' } as never], 'mac'), /unknown preference change/);
  assert.throws(() => writePreference(db, 'keybindings.app.search.open', []), /platform is required/);
  assert.throws(() => applyPreferences(db, [], 'mac'), /no preference changes/);
  assert.deepEqual(readPreferences(db), [], 'nothing was written');
});

test('a write that creates a hard conflict is refused and writes nothing', () => {
  const db = account();
  assert.throws(
    () => writePreference(db, 'keybindings.shell.sidebar.toggle', [chord('Mod+K')], 'mac'),
    new RegExp(`^Error: ${KEYBINDING_CONFLICT}: Mod\\+K on app\\.search\\.open and shell\\.sidebar\\.toggle$`),
  );
  assert.deepEqual(readPreferences(db), []);
});

test('Replace existing: moving a chord between commands commits both rows together', () => {
  const db = account();
  applyPreferences(db, [
    { op: 'set', key: 'keybindings.shell.sidebar.toggle', value: [chord('Mod+K')] },
    { op: 'set', key: 'keybindings.app.search.open', value: [chord('Mod+J')] },
  ], 'mac');
  assert.deepEqual(effective(db)['shell.sidebar.toggle']?.hotkeys, ['Mod+K']);
  assert.deepEqual(effective(db)['app.search.open']?.hotkeys, ['Mod+J']);
});

test('a batch that fails rolls back every change, including the valid ones', () => {
  const db = account();
  writePreference(db, 'appearance.theme', 'dark');
  const before = rows(db);
  assert.throws(() => applyPreferences(db, [
    { op: 'set', key: 'appearance.theme', value: 'light' },
    { op: 'clear', key: 'appearance.theme' },
  ], 'mac'), /changed twice/);
  assert.throws(() => applyPreferences(db, [
    { op: 'set', key: 'appearance.theme', value: 'light' },
    { op: 'set', key: 'keybindings.app.settings.open', value: [chord('Mod+K')] },
  ], 'mac'), new RegExp(KEYBINDING_CONFLICT));
  assert.deepEqual(rows(db), before);
});

test('a statement failing mid-transaction rolls back the ones before it', () => {
  // Validation catches everything a caller can send, so this forces the engine
  // itself to fail on the SECOND statement — the case BEGIN/ROLLBACK exists for.
  const db = account();
  db.exec(`CREATE TRIGGER refuse_back BEFORE INSERT ON preferences
           WHEN NEW.key = 'keybindings.navigation.back'
           BEGIN SELECT RAISE(ABORT, 'disk said no'); END`);
  assert.throws(() => applyPreferences(db, [
    { op: 'set', key: 'keybindings.app.search.open', value: [chord('Mod+J')] },
    { op: 'set', key: 'keybindings.navigation.back', value: [] },
  ], 'mac'), /disk said no/);
  assert.deepEqual(readPreferences(db), [], 'the first set did not survive');
});

test('a clear is conflict-checked, because the default it restores may be taken', () => {
  const db = account();
  applyPreferences(db, [
    { op: 'set', key: 'keybindings.app.search.open', value: [] },
    { op: 'set', key: 'keybindings.shell.sidebar.toggle', value: [chord('Mod+K')] },
  ], 'mac');
  assert.throws(() => applyPreferences(db, [{ op: 'clear', key: 'keybindings.app.search.open' }], 'mac'), new RegExp(KEYBINDING_CONFLICT));
  assert.equal(effective(db)['app.search.open']?.source, 'disabled', 'still disabled');
});

test('Reset all: clearing every known binding in one batch', () => {
  const db = account();
  applyPreferences(db, [
    { op: 'set', key: 'keybindings.app.search.open', value: [chord('Mod+J')] },
    { op: 'set', key: 'keybindings.navigation.back', value: [] },
    { op: 'set', key: 'appearance.theme', value: 'dark' },
  ], 'mac');
  applyPreferences(db, [
    { op: 'clear', key: 'keybindings.app.search.open' },
    { op: 'clear', key: 'keybindings.navigation.back' },
  ], 'mac');
  assert.deepEqual(Object.keys(rows(db)), ['appearance.theme'], 'reset all touches only keybindings');
});

test('an existing conflict that the batch does not touch does not block it', () => {
  // A release can change a default into a chord someone already uses. That is a
  // conflict for the settings page to show, not a reason to refuse every write.
  const db = account();
  db.prepare('INSERT INTO preferences (key, value, reach, updated_at) VALUES (?,?,?,?)')
    .run('keybindings.shell.sidebar.toggle', '[{"kind":"chord","hotkey":"Mod+K"}]', 'local', 1);
  applyPreferences(db, [{ op: 'set', key: 'keybindings.navigation.back', value: [chord('Mod+Shift+ArrowLeft')] }], 'mac');
  assert.deepEqual(effective(db)['navigation.back']?.hotkeys, ['Mod+Shift+ArrowLeft']);
});

test('a row this build cannot read survives an unrelated write, and resolves to the default', () => {
  const db = account();
  const newer = '[{"kind":"sequence","steps":["G","B"]}]';
  db.prepare('INSERT INTO preferences (key, value, reach, updated_at) VALUES (?,?,?,?)')
    .run('keybindings.navigation.back', newer, 'local', 1);
  writePreference(db, 'keybindings.app.search.open', [chord('Mod+J')], 'mac');
  assert.equal(rows(db)['keybindings.navigation.back'], newer);
  assert.equal(effective(db)['navigation.back']?.source, 'invalid');
});

test('the engine refuses reserved and character-only bindings, not only the recorder', () => {
  const db = account();
  assert.throws(() => writePreference(db, 'keybindings.app.search.open', [chord('Mod+C')], 'mac'),
    new RegExp(`${KEYBINDING_REFUSED}: Mod\\+C is reserved`));
  assert.throws(() => writePreference(db, 'keybindings.shell.sidebar.toggle', [chord('B')], 'mac'),
    new RegExp(`${KEYBINDING_REFUSED}: B is character-only`));
  writePreference(db, 'keybindings.composer.message.send', [chord('Mod+Enter')], 'mac');
  assert.deepEqual(readPreferences(db).map(row => row.key), ['keybindings.composer.message.send']);
});
