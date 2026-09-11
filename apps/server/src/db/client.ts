import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { env } from '../env.ts';
import type { DB } from './schema.ts';
// Side-effect import, and it must stay above the pool: registering pg's int8
// parser is what makes `ord` and `rev` arrive as numbers rather than strings.
// Without it the Kysely types are a lie and `next_ord + 1` concatenates.
import './types.ts';

export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });
export const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

/**
 * Is the database actually usable right now?
 *
 * A THROWAWAY CLIENT, never the shared pool, and both halves of that matter.
 *
 * Deadlined, because "reachable" and "accepting TCP" are different questions: a
 * wedged container still completes the handshake at the socket layer, so a bare
 * `SELECT 1` on the pool never resolves and never rejects. Every test file that
 * guards on it then sits in its top-level await producing no output at all,
 * which looks like a slow suite rather than a dead dependency.
 *
 * And off the pool, because the obvious repair is worse than the fault. Probing
 * through `pool` leaves a client stuck mid-handshake; that handle keeps the
 * event loop alive, so the runner reports every test as skipped and then never
 * exits — and `pool.end()` does not rescue it, because a client that is still
 * connecting is not idle, so `end` waits on the very thing that is stuck. A
 * client of its own is discarded with it, and the lazy pool is left untouched
 * with nothing open.
 *
 * Every state that waits on the outside world carries a deadline (invariant 64);
 * a test harness is not an exception to that.
 */
export async function reachable(ms = 3_000): Promise<boolean> {
  const probe = new pg.Client({
    connectionString: env.databaseUrl, connectionTimeoutMillis: ms,
  });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    // Both paths. `end` on a client that never connected is a no-op, and on one
    // that timed out it is what destroys the socket rather than leaving it.
    await probe.end().catch(() => { /* never opened */ });
  }
}
