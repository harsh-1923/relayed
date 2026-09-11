// The int8 parser (types.ts), which the allocator's arithmetic depends on.
//
// This exists because the bug it prevents is invisible: node-postgres returns
// bigint as a STRING, the Kysely types say `number`, and `next_ord + 1` on a
// string is "51". Nothing fails — not the compiler, not a happy-path test —
// until read cursors start disagreeing between clients.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, reachable } from './client.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

test('bigint arrives as a number, so arithmetic on it is arithmetic', opts, async () => {
  const { rows } = await pool.query('SELECT 5::bigint AS ord');
  assert.equal(typeof rows[0].ord, 'number');
  // The assertion that matters. Without the parser this is "51".
  assert.equal(rows[0].ord + 1, 6);
});

test('count(*) is a number too — it is int8 as well', opts, async () => {
  // Easy to forget: every aggregate count in this codebase depends on the same
  // parser, so a future `SELECT count(*)` needs no Number() wrapper.
  const { rows } = await pool.query('SELECT count(*) AS n FROM chats');
  assert.equal(typeof rows[0].n, 'number');
});

test('a bigint beyond safe-integer range throws rather than rounding', opts, async () => {
  // 2^53 + 1. A number that cannot be represented exactly, and the one case
  // where the default string behaviour was protecting us. An error here is
  // always better than a value that is quietly almost right — a rounded ordinal
  // would collide with its neighbour and corrupt a read cursor with no symptom.
  await assert.rejects(
    () => pool.query('SELECT 9007199254740993::bigint AS too_big'),
    /exceeds Number.MAX_SAFE_INTEGER/);
});

test('numeric is deliberately NOT converted', opts, async () => {
  // Arbitrary precision by definition, so converting it would be lossy for
  // exactly the reason node-postgres returns strings in the first place. Only
  // int8 is narrowed, and only because its range is known here.
  const { rows } = await pool.query('SELECT 1.5::numeric AS n');
  assert.equal(typeof rows[0].n, 'string');
});

test('NULL survives the parser', opts, async () => {
  // Parsers are not called for NULL, but asserting it means a future guard that
  // gets this wrong fails here rather than in whatever reads a nullable column.
  const { rows } = await pool.query('SELECT NULL::bigint AS n');
  assert.equal(rows[0].n, null);
});

// In a hook rather than at the end of the last test: a test added below this
// one would otherwise find the pool already closed, and the failure would point
// at the new test rather than at the teardown.
after(async () => { if (up) await pool.end(); });
