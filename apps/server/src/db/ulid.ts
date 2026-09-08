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
