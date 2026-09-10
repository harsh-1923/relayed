// Prefixed, lexicographically sortable ids. ULID over UUIDv4 because time
// ordering makes them a usable tiebreaker and far easier to read in logs.
import { randomBytes } from 'node:crypto';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford: no I, L, O, U

export function ulid(prefix: string, now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) { time = B32[t % 32] + time; t = Math.floor(t / 32); }
  const rand = [...randomBytes(16)].map(b => B32[b % 32]).join('');
  return `${prefix}_${time}${rand}`;
}

/**
 * The smallest ULID that could have been minted at `now`.
 *
 * The time prefix with a zero suffix, so `id >= floor(T)` is exactly "minted at
 * or after T". That turns a time-based retention sweep into a keyset range over
 * the PRIMARY KEY — no `created_at` index, and no index to add later on the
 * table most likely to be large by the time anyone wants one.
 *
 * Which matters more than it looks: this migration runner wraps each file in a
 * transaction and `CREATE INDEX CONCURRENTLY` cannot run inside one, so an
 * index added to `sync_events` later is a problem rather than a chore
 * (008_sync_events.sql records the same reasoning).
 */
export function ulidFloor(prefix: string, now: number): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) { time = B32[t % 32] + time; t = Math.floor(t / 32); }
  return `${prefix}_${time}${'0'.repeat(16)}`;
}
