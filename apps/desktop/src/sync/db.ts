import { DatabaseSync } from 'node:sqlite';

/**
 * Opens the local replica. See DESIGN.md §13.5 for why `node:sqlite` and not a
 * native binding, and §8.3 for the pragma set.
 */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);

  // ⚠ ORDER MATTERS (invariant 11). `auto_vacuum` must be the FIRST statement
  // executed against a new file — before journal_mode, before any table.
  // Setting WAL first materialises the database header, after which auto_vacuum
  // is SILENTLY IGNORED: it reports 0, with no error.
  db.exec('PRAGMA auto_vacuum  = INCREMENTAL');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous  = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  // Assert, do not trust. A silent 0 here means eviction can never reclaim
  // disk, and the only fix in the field is a dump-and-reload migration.
  const row = db.prepare('SELECT * FROM pragma_auto_vacuum()').get() as Record<string, number>;
  const autoVacuum = Object.values(row)[0];
  if (autoVacuum !== 2) {
    throw new Error(
      `auto_vacuum is ${autoVacuum}, expected 2 (INCREMENTAL). The pragma was ` +
      `ignored — it must run before journal_mode on a new file (§13.5).`,
    );
  }
  return db;
}
