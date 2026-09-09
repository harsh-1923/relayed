import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, grantKey, ACTIONS, type Grants, type Placement, type Role, type Scope } from './index.ts';

const PLACEMENT: Placement = {
  workspaceOf: { S_pub: 'W', S_priv: 'W' },
  spaceOf: { C_pub: 'S_pub', C_priv: 'S_priv', C_open: 'S_priv' },
  privateChats: new Set(['C_priv']),
};

const g = (...pairs: [Scope, string, Role][]): Grants =>
  new Map(pairs.map(([s, i, r]) => [grantKey(s, i), r]));

const everyTarget: [Scope, string][] = [
  ['workspace', 'W'], ['space', 'S_pub'], ['space', 'S_priv'],
  ['chat', 'C_pub'], ['chat', 'C_priv'], ['chat', 'C_open'],
];

const answers = (grants: Grants) =>
  everyTarget.flatMap(([scope, id]) =>
    ACTIONS[scope].map(a => [`${a}@${scope}:${id}`, can(grants, a, { scope, id }, PLACEMENT)] as const));

/**
 * Invariant 49, as a property rather than an example.
 *
 * The client answers from a REPLICA, which can lag or be incomplete — a
 * membership added a moment ago may not have arrived. The safety of the whole
 * arrangement rests on that lag being able to produce only one kind of error:
 * hiding something permitted. If a missing grant could ever produce a `true`,
 * a stale client would grant permissions the server denies.
 */
test('a client with FEWER grants can never permit more than the server', () => {
  const full = g(['workspace', 'W', 'owner'],
                 ['space', 'S_pub', 'admin'],
                 ['space', 'S_priv', 'admin'],
                 ['chat', 'C_priv', 'member']);
  const authoritative = new Map(answers(full));

  // Every proper subset of what the server holds — every way a replica could
  // be behind.
  const keys = [...full.keys()];
  for (let mask = 0; mask < (1 << keys.length); mask++) {
    const partial: Grants = new Map(
      keys.filter((_, i) => mask & (1 << i)).map(k => [k, full.get(k)!]));
    for (const [q, mine] of answers(partial)) {
      if (mine && !authoritative.get(q)) {
        assert.fail(`a lagging replica PERMITTED "${q}" that the server denies`);
      }
    }
  }
});

test('a lower role can never permit more than a higher one', () => {
  const ladder: Role[] = ['member', 'admin', 'owner'];
  for (let i = 0; i < ladder.length - 1; i++) {
    const lower = new Map(answers(g(['workspace', 'W', ladder[i]!])));
    const higher = new Map(answers(g(['workspace', 'W', ladder[i + 1]!])));
    for (const [q, allowed] of lower) {
      if (allowed) assert.ok(higher.get(q), `${ladder[i]} may "${q}" but ${ladder[i + 1]} may not`);
    }
  }
});

test('no grants at all permits nothing at all', () => {
  const none = answers(new Map());
  assert.deepEqual(none.filter(([, allowed]) => allowed).map(([q]) => q), []);
});

test('the evaluator is pure — same inputs, same answer, no hidden state', () => {
  const grants = g(['workspace', 'W', 'admin'], ['space', 'S_pub', 'member']);
  const first = answers(grants);
  for (let i = 0; i < 3; i++) assert.deepEqual(answers(grants), first);
});

test('an action from another scope is denied, not silently accepted', () => {
  const owner = g(['workspace', 'W', 'owner'], ['space', 'S_pub', 'admin']);
  // `invite` is a workspace action; `make_public` is a space one.
  assert.equal(can(owner, 'invite', { scope: 'space', id: 'S_pub' }, PLACEMENT), false);
  assert.equal(can(owner, 'make_public', { scope: 'workspace', id: 'W' }, PLACEMENT), false);
  assert.equal(can(owner, 'read', { scope: 'workspace', id: 'W' }, PLACEMENT), false);
});

test('placement is required — an unplaced object resolves to nothing', () => {
  const owner = g(['workspace', 'W', 'owner'], ['space', 'S_pub', 'admin'],
                  ['chat', 'C_ghost', 'member']);
  // No spaceOf entry: the containment chain cannot be walked, so it is denied
  // rather than treated as top-level.
  assert.equal(can(owner, 'read', { scope: 'chat', id: 'C_ghost' }, PLACEMENT), false);
  assert.equal(can(owner, 'read', { scope: 'space', id: 'S_ghost' }, PLACEMENT), false);
});
