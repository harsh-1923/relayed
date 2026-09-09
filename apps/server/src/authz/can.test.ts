import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, ACTIONS, type Grants, type Placement, type Role, type Scope } from '@relayed/authz';
// The spike (docs/AUTHZ.md §12.1) validated that these rules can be evaluated
// as relationship tuples and as direct branching with identical results. That
// proved the MODEL. This proves the SHIPPED CODE is the same model — a spike
// that never meets the implementation only validates a document.
import { World } from '../../../../spikes/authz-model.mjs';

interface Fixture {
  workspaces: string[];
  spaces: Record<string, string>;                    // space -> workspace
  chats: Record<string, { space: string; private: boolean }>;
  members: [Scope, string, string, Role][];          // scope, id, actor, role
  left?: [Scope, string, string][];
}

function build(f: Fixture) {
  const w = new World();
  for (const ws of f.workspaces) w.workspace(ws);
  for (const [s, ws] of Object.entries(f.spaces)) w.space(s, ws);
  for (const [c, meta] of Object.entries(f.chats)) w.chat(c, meta.space, meta.private ? 'private' : 'public');
  for (const [scope, id, actor, role] of f.members) w.join(scope, id, actor, role);
  for (const [scope, id, actor] of f.left ?? []) w.leave(scope, id, actor);

  const placement: Placement = {
    workspaceOf: f.spaces,
    spaceOf: Object.fromEntries(Object.entries(f.chats).map(([c, m]) => [c, m.space])),
    privateChats: new Set(Object.entries(f.chats).filter(([, m]) => m.private).map(([c]) => c)),
  };
  const gone = new Set((f.left ?? []).map(([s, i, a]) => `${s}:${i}:${a}`));
  const grantsFor = (actor: string): Grants => new Map(
    f.members
      .filter(([s, i, a]) => a === actor && !gone.has(`${s}:${i}:${a}`))
      .map(([s, i, , role]) => [`${s}:${i}`, role]));

  return { world: w, placement, grantsFor };
}

/** The same shapes the spike uses, including the ones that should never occur. */
const FIXTURE: Fixture = {
  workspaces: ['W'],
  spaces: { S_pub: 'W', S_priv: 'W' },
  chats: {
    C_pub:  { space: 'S_pub',  private: false },
    C_priv: { space: 'S_priv', private: true },
    C_open: { space: 'S_priv', private: false },
  },
  members: [
    ['workspace', 'W', 'a_owner', 'owner'],
    ['workspace', 'W', 'a_admin', 'admin'],
    ['workspace', 'W', 'a_member', 'member'],
    ['workspace', 'W', 'a_space_admin', 'member'],
    ['workspace', 'W', 'a_ghost', 'member'],
    ['space', 'S_pub', 'a_member', 'member'],
    ['space', 'S_pub', 'a_space_admin', 'admin'],
    ['space', 'S_priv', 'a_space_admin', 'admin'],
    ['space', 'S_priv', 'a_member', 'member'],
    ['chat', 'C_priv', 'a_space_admin', 'member'],
    // The states that make containment observable — an orphaned space
    // membership, and someone who left the workspace holding inner rows.
    ['space', 'S_priv', 'a_orphan', 'admin'],
    ['chat', 'C_priv', 'a_orphan', 'member'],
    ['workspace', 'W', 'a_left_ws', 'admin'],
    ['space', 'S_priv', 'a_left_ws', 'admin'],
    ['chat', 'C_priv', 'a_left_ws', 'member'],
  ],
  left: [['workspace', 'W', 'a_ghost'], ['workspace', 'W', 'a_left_ws']],
};

const ACTORS = ['a_owner', 'a_admin', 'a_member', 'a_space_admin',
                'a_outsider', 'a_ghost', 'a_orphan', 'a_left_ws'];

test('the shipped evaluator agrees with the validated model, exhaustively', () => {
  const { world, placement, grantsFor } = build(FIXTURE);
  const disagreements: string[] = [];
  let checks = 0, allowed = 0;

  for (const actor of ACTORS) {
    const grants = grantsFor(actor);
    const targets: [Scope, string][] = [
      ...FIXTURE.workspaces.map(w => ['workspace', w] as [Scope, string]),
      ...Object.keys(FIXTURE.spaces).map(s => ['space', s] as [Scope, string]),
      ...Object.keys(FIXTURE.chats).map(c => ['chat', c] as [Scope, string]),
    ];
    for (const [scope, id] of targets) {
      for (const action of ACTIONS[scope]) {
        checks += 1;
        const mine = can(grants, action, { scope, id }, placement);
        const model = world.can(actor, action, scope, id) as boolean;
        if (mine) allowed += 1;
        if (mine !== model) disagreements.push(`${actor} ${action} ${scope}:${id} → ${mine} vs ${model}`);
      }
    }
  }

  assert.deepEqual(disagreements, []);
  // A control on the control: two evaluators that both always deny agree
  // perfectly and prove nothing.
  assert.equal(checks, ACTORS.length * (4 + 5 * 2 + 5 * 3));
  assert.ok(allowed > 20 && allowed < checks - 20, `${allowed}/${checks} allowed — suspiciously uniform`);
});

test('an unknown action or scope is denied, never defaulted', () => {
  const { placement, grantsFor } = build(FIXTURE);
  const owner = grantsFor('a_owner');
  assert.equal(can(owner, 'nuke', { scope: 'workspace', id: 'W' }, placement), false);
  assert.equal(can(owner, 'invite', { scope: 'space', id: 'W' }, placement), false,
    'an action valid on another scope is not valid here');
  assert.equal(can(owner, 'read', { scope: 'chat', id: 'nope' }, placement), false,
    'an object with no placement resolves to nothing');
});

test('containment: a space grants nothing without the workspace above it', () => {
  const { placement, grantsFor } = build(FIXTURE);
  // a_orphan is a space ADMIN and a chat member, and belongs to no workspace.
  const orphan = grantsFor('a_orphan');
  assert.equal(can(orphan, 'read', { scope: 'space', id: 'S_priv' }, placement), false);
  assert.equal(can(orphan, 'make_public', { scope: 'space', id: 'S_priv' }, placement), false);
  assert.equal(can(orphan, 'read', { scope: 'chat', id: 'C_priv' }, placement), false);
});

test('the leading conjunct: leaving a space denies its private chats', () => {
  const { placement } = build(FIXTURE);
  const held: Grants = new Map([['workspace:W', 'member'], ['space:S_priv', 'member'],
                                ['chat:C_priv', 'member']]);
  assert.equal(can(held, 'read', { scope: 'chat', id: 'C_priv' }, placement), true);

  // The same actor, minus ONLY the space row. No chat row was touched.
  const left: Grants = new Map([['workspace:W', 'member'], ['chat:C_priv', 'member']]);
  assert.equal(can(left, 'read', { scope: 'chat', id: 'C_priv' }, placement), false);
  assert.equal(can(left, 'read', { scope: 'chat', id: 'C_open' }, placement), false);
});

test('a workspace role never inherits space-level read (invariant 51)', () => {
  const { placement, grantsFor } = build(FIXTURE);
  const admin = grantsFor('a_admin');
  assert.equal(can(admin, 'invite', { scope: 'workspace', id: 'W' }, placement), true);
  assert.equal(can(admin, 'read', { scope: 'space', id: 'S_priv' }, placement), false);
  assert.equal(can(admin, 'read', { scope: 'chat', id: 'C_priv' }, placement), false);
});

test('what invitations actually need', () => {
  const { placement } = build(FIXTURE);
  const owner: Grants  = new Map([['workspace:W', 'owner']]);
  const admin: Grants  = new Map([['workspace:W', 'admin']]);
  const member: Grants = new Map([['workspace:W', 'member']]);
  const none: Grants   = new Map();

  assert.equal(can(owner,  'invite', { scope: 'workspace', id: 'W' }, placement), true);
  assert.equal(can(admin,  'invite', { scope: 'workspace', id: 'W' }, placement), true);
  assert.equal(can(member, 'invite', { scope: 'workspace', id: 'W' }, placement), false);
  assert.equal(can(none,   'invite', { scope: 'workspace', id: 'W' }, placement), false);
  // Only the owner may hand the workspace on.
  assert.equal(can(admin, 'transfer_ownership', { scope: 'workspace', id: 'W' }, placement), false);
  assert.equal(can(owner, 'transfer_ownership', { scope: 'workspace', id: 'W' }, placement), true);
});
