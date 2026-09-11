// Forward-only SQL migrations. Plain .sql files on purpose: the schema is the
// artifact of record (STACK.md §1), not generated output from TypeScript.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../env.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(connectionString = env.databaseUrl): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM _migrations')).rows.map(r => r.name));

    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      // Each migration in its own transaction: a failure leaves the database on
      // the last complete version rather than half-applied.
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO _migrations(name) VALUES($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(e as Error).message}`, { cause: e });
      }
    }
  } finally { await client.end(); }
  return applied;
}

if (import.meta.filename === process.argv[1]) {
  const applied = await migrate();
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
}
