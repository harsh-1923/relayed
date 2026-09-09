// How Postgres values arrive in JavaScript.
//
// Importing this module IS the registration — `pg.types.setTypeParser` mutates
// pg's global parser table, so it must run before the first query rather than
// be something a caller remembers to invoke.
import pg from 'pg';

/** `int8` / `bigint`. */
const INT8 = 20;

/**
 * Read `bigint` as a number rather than as a string.
 *
 * node-postgres returns int8 as a STRING by default, because int8 spans a
 * larger range than a JavaScript number can hold exactly. That default is
 * correct in general and actively dangerous here: `ord` and `rev` are int8, the
 * Kysely types call them `number`, and `next_ord + 1` on a string is `"51"`
 * rather than 51 — silently, with the compiler satisfied.
 *
 * Found by running a query rather than by reading one. The allocator in
 * `sync/allocate.ts` does arithmetic on both counters, so this is the
 * difference between an ordinal sequence and string concatenation in the
 * twenty lines the whole sync core rests on.
 *
 * Only int8 is converted. `numeric` (OID 1700) is also delivered as a string
 * and is deliberately left alone: it is arbitrary-precision by definition, so
 * converting it would be lossy for the reason the default exists.
 *
 * The range question, answered rather than assumed: a JavaScript number holds
 * every integer up to 2^53 - 1 exactly. `ord` and `rev` count messages and
 * mutations in ONE chat, and `count(*)` counts rows in one table — nine
 * quadrillion of either is not a number this system will produce. The guard
 * below exists anyway, because a silent precision loss at that boundary would
 * corrupt read cursors with no symptom, and an error is always better than a
 * number that is quietly almost right.
 */
pg.types.setTypeParser(INT8, (raw: string): number => {
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `bigint ${raw} exceeds Number.MAX_SAFE_INTEGER and cannot be read as a ` +
      `number without losing precision. Read this column as a string or a ` +
      `BigInt at the call site rather than widening this parser.`,
    );
  }
  return value;
});
