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
 *
 * The runner is generic because there are now two schemas on two independent
 * version lines (STORAGE.md §5): one `account.db` per account, and one replica
 * per workspace underneath it. Each file carries its own `user_version`, so a
 * new workspace opened years later starts at 0 and catches up on its own.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

export interface MigrationResult { from: number; to: number; applied: string[] }

export function migrate(db: DatabaseSync, migrations: readonly Migration[]): MigrationResult {
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
      throw new Error(`migration ${m.version} (${m.name}) failed: ${(e as Error).message}`,
                      { cause: e });
    }
  }
  return { from, to: applied.length ? pending.at(-1)!.version : from, applied };
}
