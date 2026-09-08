import type { DatabaseSync } from 'node:sqlite';

/**
 * Forward-only migrations keyed on SQLite's `user_version`.
 *
 * This must exist before the first build anyone else runs (RELEASE.md §6):
 * reinstalling replaces the app but leaves userData intact, so new code always
 * meets an old database, and a user who skips releases jumps several versions
 * at once.
 *
 * The local database is a replica — if a migration is ever infeasible,
 * wipe-and-resync is a legitimate escape hatch that a server DB never has.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'meta',
    up: `
      CREATE TABLE meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      INSERT INTO meta(k, v) VALUES ('schema_origin', 'phase0');
    `,
  },
];

export interface MigrationResult { from: number; to: number; applied: string[] }

export function migrate(db: DatabaseSync): MigrationResult {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const from = row.user_version;
  const pending = migrations.filter(m => m.version > from).toSorted((a, b) => a.version - b.version);
  const applied: string[] = [];

  for (const m of pending) {
    db.exec('BEGIN');
    try {
      db.exec(m.up);
      // Not parameterisable, and the value comes from our own migration list,
      // never from input — so interpolation is safe here specifically.
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
      applied.push(`${m.version}:${m.name}`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.version} (${m.name}) failed: ${(e as Error).message}`);
    }
  }
  return { from, to: from + applied.length === from ? from : pending.at(-1)?.version ?? from, applied };
}
