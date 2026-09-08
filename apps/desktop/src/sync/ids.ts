import { randomBytes } from 'node:crypto';

// Crockford base32: no I, L, O or U, so an id read aloud or copied out of a log
// cannot be transcribed wrong.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Opaque local identifier. Never derived from anything meaningful. */
export const newId = (prefix: string): string =>
  `${prefix}_` + [...randomBytes(16)].map(b => B32[b % 32]).join('');
