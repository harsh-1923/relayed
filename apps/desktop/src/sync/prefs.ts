// The preferences table, read and written (PREFERENCES.md §6).
//
// Takes a handle rather than reaching for one, so the store can be tested
// against a migrated database with no Storage, no account directory and no
// process around it — which is what the constraint tests need.
import type { DatabaseSync } from 'node:sqlite';
import { encode, type PreferenceRow, type PreferenceReach } from '../shared/prefs.ts';

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
export function writePreference(db: DatabaseSync, key: string, value: unknown): void {
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
