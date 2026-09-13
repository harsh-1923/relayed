// The preferences table, read and written (PREFERENCES.md §6).
//
// Takes a handle rather than reaching for one, so the store can be tested
// against a migrated database with no Storage, no account directory and no
// process around it — which is what the constraint tests need.
import type { DatabaseSync } from 'node:sqlite';
import {
  encode, isKeybindingKey, isWritablePreferenceKey, KEYBINDING_PREFIX,
  type PreferenceRow, type PreferenceReach,
} from '../shared/prefs.ts';
import type { CommandId } from '../shared/shortcuts/catalogue.ts';
import { bindingProblem, findConflicts, resolveBindings } from '../shared/shortcuts/resolve.ts';
import type { Platform } from '../shared/shortcuts/tanstack-driver.ts';

/**
 * Every row, as stored.
 *
 * Returned undecoded. Decoding needs the catalogue's fallback for anything this
 * build cannot parse, and the one place that wants a decoded value is the
 * surface asking for a specific key — so `decode` lives beside the catalogue
 * and this stays a read.
 */
export function readPreferences(db: DatabaseSync): PreferenceRow[] {
  return (db.prepare('SELECT key, value, reach FROM preferences ORDER BY key')
    .all() as Record<string, unknown>[]).map(r => ({
      key: String(r['key']),
      value: String(r['value']),
      reach: (r['reach'] === 'synced' ? 'synced' : 'local') as PreferenceReach,
    }));
}

/**
 * Set one preference. Validated against the catalogue first, so an unknown key
 * or a value outside its domain never reaches the table.
 *
 * An UPSERT rather than a delete-and-insert: one statement, one row, and no
 * window in which the setting does not exist.
 */
export function writePreference(db: DatabaseSync, key: string, value: unknown, platform?: Platform): void {
  // A binding is never written alone: whether it is valid depends on every
  // other binding, so it takes the path that checks the resulting set.
  if (isKeybindingKey(key)) {
    if (!platform) throw new Error(`a platform is required to write ${key}`);
    applyPreferences(db, [{ op: 'set', key, value }], platform);
    return;
  }
  const encoded = encode(key, value);
  db.prepare(`
    INSERT INTO preferences (key, value, reach, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value, reach = excluded.reach, updated_at = excluded.updated_at
  `).run(key, encoded.value, encoded.reach, Date.now());
}

/**
 * Drop one preference, returning it to its default.
 *
 * Deleting rather than writing the default is the whole of PREFERENCES.md §7:
 * a stored default would freeze today's answer into every install that ever
 * opened the screen, so changing it later would need a data migration instead
 * of a release.
 */
export function clearPreference(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM preferences WHERE key = ?').run(key);
}

export type PreferenceChange =
  | { readonly op: 'set'; readonly key: string; readonly value: unknown }
  | { readonly op: 'clear'; readonly key: string };

/** The message a refused conflicting write carries, so a surface can recognise it. */
export const KEYBINDING_CONFLICT = 'keybinding conflict';

/** The message a refused reserved or character-only binding carries. */
export const KEYBINDING_REFUSED = 'keybinding refused';

/**
 * Apply several sets and clears as one transaction, or none of them
 * (SHORTCUTS.md §9.2).
 *
 * The shortcut settings need this and a sequence of single writes cannot give
 * it: "Replace existing" moves a chord from one command to another, and if the
 * second write failed the person would be left with the chord on both commands
 * or on neither. Reset-all is the same shape with more rows.
 *
 * Everything is validated before anything is written. For keybinding keys that
 * includes the resulting binding set: a HARD conflict involving a command this
 * batch touched is refused. One that does not involve the batch is left alone —
 * a release that changed a default must not make every unrelated write fail.
 */
export function applyPreferences(
  db: DatabaseSync, changes: readonly PreferenceChange[], platform: Platform,
): void {
  if (!Array.isArray(changes) || changes.length === 0) throw new Error('no preference changes');
  const keys = new Set<string>();
  const statements = changes.map(change => {
    if (typeof change !== 'object' || change === null || !isWritablePreferenceKey(change.key)) {
      throw new Error(`unknown preference: ${String((change as { key?: unknown } | null)?.key)}`);
    }
    if (keys.has(change.key)) throw new Error(`preference changed twice in one batch: ${change.key}`);
    keys.add(change.key);
    if (change.op === 'clear') return { key: change.key, encoded: null };
    if (change.op === 'set') return { key: change.key, encoded: encode(change.key, change.value, platform) };
    throw new Error(`unknown preference change: ${String((change as { op?: unknown }).op)}`);
  });

  const touched = statements.filter(statement => isKeybindingKey(statement.key));
  if (touched.length > 0) {
    const overrides = new Map<string, unknown>();
    for (const row of readPreferences(db)) {
      if (!row.key.startsWith(KEYBINDING_PREFIX)) continue;
      try { overrides.set(row.key.slice(KEYBINDING_PREFIX.length), JSON.parse(row.value)); } catch { /* resolves as invalid */ }
    }
    for (const statement of touched) {
      const id = statement.key.slice(KEYBINDING_PREFIX.length);
      if (statement.encoded === null) {
        overrides.delete(id);
        continue;
      }
      const bindings = JSON.parse(statement.encoded.value) as { hotkey: string }[];
      for (const { hotkey } of bindings) {
        const problem = bindingProblem(id as CommandId, hotkey, platform);
        if (problem) throw new Error(`${KEYBINDING_REFUSED}: ${hotkey} is ${problem} for ${id}`);
      }
      overrides.set(id, bindings);
    }
    const touchedIds = new Set(touched.map(statement => statement.key.slice(KEYBINDING_PREFIX.length) as CommandId));
    const hard = findConflicts(resolveBindings(overrides, platform))
      .filter(conflict => conflict.kind === 'hard' && conflict.commands.some(id => touchedIds.has(id)));
    if (hard.length > 0) {
      throw new Error(`${KEYBINDING_CONFLICT}: ${hard.map(conflict => `${conflict.hotkey} on ${conflict.commands.join(' and ')}`).join('; ')}`);
    }
  }

  const upsert = db.prepare(`
    INSERT INTO preferences (key, value, reach, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value, reach = excluded.reach, updated_at = excluded.updated_at
  `);
  const remove = db.prepare('DELETE FROM preferences WHERE key = ?');
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const statement of statements) {
      if (statement.encoded === null) remove.run(statement.key);
      else upsert.run(statement.key, statement.encoded.value, statement.encoded.reach, now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
