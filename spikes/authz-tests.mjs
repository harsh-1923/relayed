// Tests the claims in docs/AUTHZ.md against the executable model.
// Run: pnpm spike:authz
import { World, check, section, results, everyCheck, ACTIONS } from './authz-model.mjs';

/** A workspace with a public channel, a private room, and chats in each. */
function world() {
  const w = new World();
  w.workspace('W');
  w.space('S_pub', 'W', 'public');
  w.space('S_priv', 'W', 'private');
  w.chat('C_pub', 'S_pub', 'public');
  w.chat('C_priv', 'S_priv', 'private');
  w.chat('C_open', 'S_priv', 'public');   // public chat inside a private room
  w.agent('A', 'W');
  return w;
}

// ── §12.1 the equivalence claim — the reason this spike exists ───────────────
section('§10  the portability claim: direct and tuple evaluation agree');
{
  // Every shape of membership, exhaustively — INCLUDING the shapes that should
  // never occur, because those are the only ones that distinguish the two
  // evaluators. A fixture where every space member is also a workspace member
  // agrees with itself no matter what the containment rule says: a negative
  // control caught exactly that, with the tuple evaluator's containment check
  // deleted and the suite still green.
  const actors = ['a_owner', 'a_admin', 'a_member', 'a_space_admin',
                  'a_outsider', 'a_ghost', 'a_orphan', 'a_left_ws',
                  'a_maintainer', 'a_foreign_maintainer'];
  const w = world();
  w.join('workspace', 'W', 'a_owner', 'owner');
  w.join('workspace', 'W', 'a_admin', 'admin');
  w.join('workspace', 'W', 'a_member', 'member');
  w.join('workspace', 'W', 'a_space_admin', 'member');
  // a_outsider is in nothing at all; a_ghost left the workspace holding nothing else.
  w.join('workspace', 'W', 'a_ghost', 'member');
  w.leave('workspace', 'W', 'a_ghost');

  w.join('space', 'S_pub', 'a_member');
  w.join('space', 'S_pub', 'a_space_admin', 'admin');
  w.join('space', 'S_priv', 'a_space_admin', 'admin');
  w.join('space', 'S_priv', 'a_member');
  w.join('chat', 'C_priv', 'a_space_admin');

  // The two that make containment observable.
  // a_orphan holds space and chat rows and was NEVER a workspace member — the
  // state a bug or a partial import would produce.
  w.join('space', 'S_priv', 'a_orphan', 'admin');
  w.join('chat', 'C_priv', 'a_orphan');
  // a_left_ws held everything and left the WORKSPACE only; the inner rows
  // remain, which is what a tombstone-not-delete policy guarantees (§6.3).
  w.join('workspace', 'W', 'a_left_ws', 'admin');
  w.join('space', 'S_priv', 'a_left_ws', 'admin');
  w.join('chat', 'C_priv', 'a_left_ws');
  w.leave('workspace', 'W', 'a_left_ws');
  w.join('agent', 'A', 'a_left_ws', 'admin');

  // Agents (WORKSPACE-AGENTS.md §4.4). A maintainer in the workspace; and the
  // negative control — a member of ANOTHER workspace holding an admin row on
  // this workspace's agent, which only containment can refuse.
  w.workspace('W2');
  w.join('workspace', 'W', 'a_maintainer', 'member');
  w.join('agent', 'A', 'a_maintainer', 'admin');
  w.join('workspace', 'W2', 'a_foreign_maintainer', 'admin');
  w.join('agent', 'A', 'a_foreign_maintainer', 'admin');

  const checks = everyCheck(w, actors);
  const disagreements = checks.filter(([a, action, type, id]) =>
    w.can(a, action, type, id) !== w.checkTuple(a, action, type, id));

  check(`all ${checks.length} checks evaluate identically both ways`,
        disagreements.map(d => d.join('/')), []);

  // A control on the control. "They agree" is trivially true if the domain is
  // small, or if every answer is the same — two evaluators that both always say
  // no agree perfectly and prove nothing.
  const expected = actors.length
    * (ACTIONS.workspace.length * w.workspaces.size
     + ACTIONS.space.length * w.spaces.size
     + ACTIONS.chat.length * w.chats.size
     + ACTIONS.agent.length * w.agents.size);
  const trues = checks.filter(([a, act, t, i]) => w.can(a, act, t, i)).length;
  check('the domain is every actor x object x action', checks.length, expected);
  check('and the answers are genuinely mixed',
        [trues > 20, trues < checks.length - 20], [true, true]);
  // Named explicitly so the fixture cannot lose them silently: these are the
  // only actors for whom the containment conjunct changes the answer.
  check('an orphaned space membership grants nothing',
        [w.can('a_orphan', 'read', 'space', 'S_priv'),
         w.can('a_orphan', 'read', 'chat', 'C_priv')], [false, false]);
  check('leaving the WORKSPACE denies everything inside it',
        [w.can('a_left_ws', 'read', 'space', 'S_priv'),
         w.can('a_left_ws', 'read', 'chat', 'C_priv'),
         w.can('a_left_ws', 'invite', 'workspace', 'W'),
         w.can('a_left_ws', 'edit', 'agent', 'A')], [false, false, false, false]);
  check('an admin row on an agent from ANOTHER workspace grants nothing',
        ACTIONS.agent.map(a => w.can('a_foreign_maintainer', a, 'agent', 'A')),
        ACTIONS.agent.map(() => false));
}

// ── invariant 50: the leading conjunct ───────────────────────────────────────
section('§7  space membership is the leading conjunct of chat access');
{
  const w = world();
  w.join('workspace', 'W', 'a_x').join('space', 'S_priv', 'a_x').join('chat', 'C_priv', 'a_x');
  check('member of space AND chat can read the private chat', w.can('a_x', 'read', 'chat', 'C_priv'), true);

  const chatRowsBefore = w.memberships.filter(m => m.scopeType === 'chat' && m.leftAt === null).length;
  w.leave('space', 'S_priv', 'a_x');
  check('removing them from the SPACE denies the private chat', w.can('a_x', 'read', 'chat', 'C_priv'), false);
  check('and the public chat inside that space',               w.can('a_x', 'read', 'chat', 'C_open'), false);

  const chatRowsAfter = w.memberships.filter(m => m.scopeType === 'chat' && m.leftAt === null).length;
  // The point of the conjunct: no chat row had to be found and updated. A design
  // needing that sweep would leak access whenever the sweep missed one.
  check('without touching a single chat membership row', [chatRowsBefore, chatRowsAfter], [1, 1]);
}

section('§7  a private chat needs BOTH memberships');
{
  const w = world();
  w.join('workspace', 'W', 'a_space_only').join('space', 'S_priv', 'a_space_only');
  check('space membership alone does not grant a private chat',
        w.can('a_space_only', 'read', 'chat', 'C_priv'), false);
  check('but does grant a public chat in the same space',
        w.can('a_space_only', 'read', 'chat', 'C_open'), true);

  const w2 = world();
  w2.join('workspace', 'W', 'a_chat_only').join('chat', 'C_priv', 'a_chat_only');
  check('a chat row alone does not grant it either',
        w2.can('a_chat_only', 'read', 'chat', 'C_priv'), false);
}

// ── invariant 51: no admin inheritance ───────────────────────────────────────
section('§7  a workspace role never inherits space-level read');
{
  const w = world();
  w.join('workspace', 'W', 'a_admin', 'admin');
  w.join('workspace', 'W', 'a_owner', 'owner');
  check('workspace admin may invite',            w.can('a_admin', 'invite', 'workspace', 'W'), true);
  check('workspace admin CANNOT read a private space they are not in',
        w.can('a_admin', 'read', 'space', 'S_priv'), false);
  check('nor its private chat',                  w.can('a_admin', 'read', 'chat', 'C_priv'), false);
  check('the owner has no more reach than the admin here',
        w.can('a_owner', 'read', 'chat', 'C_priv'), false);
  check('only the owner may transfer ownership',
        [w.can('a_owner', 'transfer_ownership', 'workspace', 'W'),
         w.can('a_admin', 'transfer_ownership', 'workspace', 'W')], [true, false]);
}

// ── WORKSPACE-AGENTS §4.4: the one reach of a workspace role ─────────────────
section('§7  agents: maintainers and workspace admins, and nobody else');
{
  const w = world();
  w.join('workspace', 'W', 'a_member');
  w.join('workspace', 'W', 'a_maint').join('agent', 'A', 'a_maint', 'admin');
  w.join('workspace', 'W', 'a_admin', 'admin');
  check('any member reads the definition, and may create an agent',
        [w.can('a_member', 'read_definition', 'agent', 'A'),
         w.can('a_member', 'create_agent', 'workspace', 'W')], [true, true]);
  check('a member may not edit, manage maintainers or deactivate',
        ['edit', 'manage_maintainers', 'deactivate'].map(a => w.can('a_member', a, 'agent', 'A')),
        [false, false, false]);
  check('a maintainer may do all three',
        ['edit', 'manage_maintainers', 'deactivate'].map(a => w.can('a_maint', a, 'agent', 'A')),
        [true, true, true]);
  check('a workspace admin may too, holding no row on the agent',
        ['edit', 'manage_maintainers', 'deactivate'].map(a => w.can('a_admin', a, 'agent', 'A')),
        [true, true, true]);
  check('and still reads no private space (invariant 51 untouched)',
        w.can('a_admin', 'read', 'space', 'S_priv'), false);
  w.leave('agent', 'A', 'a_maint');
  check('a maintainer removed is a member again', w.can('a_maint', 'edit', 'agent', 'A'), false);
}

// ── §6 the deliberate asymmetry ──────────────────────────────────────────────
section('§6  add_member is open, make_public is not');
{
  const w = world();
  w.join('workspace', 'W', 'a_m').join('space', 'S_priv', 'a_m');
  w.join('workspace', 'W', 'a_a').join('space', 'S_priv', 'a_a', 'admin');
  check('any member may add a member',   w.can('a_m', 'add_member', 'space', 'S_priv'), true);
  check('only an admin may make public', [w.can('a_m', 'make_public', 'space', 'S_priv'),
                                          w.can('a_a', 'make_public', 'space', 'S_priv')], [false, true]);
  check('only an admin may promote',     [w.can('a_m', 'promote', 'space', 'S_priv'),
                                          w.can('a_a', 'promote', 'space', 'S_priv')], [false, true]);
  check('only a space admin may delete anyone\'s message',
        [w.can('a_m', 'delete_any', 'chat', 'C_open'),
         w.can('a_a', 'delete_any', 'chat', 'C_open')], [false, true]);
}

// ── §10 the trigger: delegation is what FGA is held in reserve for ───────────
section('§6.4  delegation intersects, and is scoped and time-boxed');
{
  const w = world();
  // Alice is in the private room; the agent is a member too, but that alone
  // must not be enough.
  w.join('workspace', 'W', 'alice').join('space', 'S_priv', 'alice').join('chat', 'C_priv', 'alice');
  w.join('workspace', 'W', 'agent').join('space', 'S_priv', 'agent').join('chat', 'C_priv', 'agent');
  w.chat('C_other', 'S_priv', 'public');
  w.delegate('agent', 'alice', 'C_priv', 'post', 100);

  check('with a valid grant, the agent may post',
        w.canAsAgent('agent', 'alice', 'post', 'C_priv', 0), true);
  check('the grant does not cover another action',
        w.canAsAgent('agent', 'alice', 'delete_any', 'C_priv', 0), false);
  check('nor another chat in the SAME room (§7.3: chat-scoped, not room-scoped)',
        w.canAsAgent('agent', 'alice', 'post', 'C_other', 0), false);
  check('and it expires',
        w.canAsAgent('agent', 'alice', 'post', 'C_priv', 100), false);

  // The intersection rule. Alice loses access; the agent still holds every
  // membership of its own — and must still be denied.
  w.leave('chat', 'C_priv', 'alice');
  check('agent still holds its own membership',
        w.can('agent', 'post', 'chat', 'C_priv'), true);
  check('but is denied once its PRINCIPAL is denied (intersection)',
        w.canAsAgent('agent', 'alice', 'post', 'C_priv', 0), false);
}

// ── invariant 53: a permission is a row ──────────────────────────────────────
section('§4  a permission is a row, so changing one changes exactly one row');
{
  const w = world();
  w.join('workspace', 'W', 'a_p').join('space', 'S_priv', 'a_p');
  const before = w.memberships.length;
  check('member cannot make public',  w.can('a_p', 'make_public', 'space', 'S_priv'), false);

  const r = w.promote('space', 'S_priv', 'a_p', 'admin');
  check('promotion changed something', r.changed, true);
  check('and now they can',           w.can('a_p', 'make_public', 'space', 'S_priv'), true);
  check('no row was added or removed', w.memberships.length, before);
  // A promotion that had to rewrite chats or messages would be a design where
  // permission is a property of the object rather than a relation.
  check('the tuple set changed only in its relation',
        w.tuples().filter(t => t.object === 'space:S_priv' && t.relation === 'admin').length, 1);
}

// ── §6 the vocabularies stay closed ──────────────────────────────────────────
section('§6  the action vocabulary is closed');
{
  const w = world();
  w.join('workspace', 'W', 'a_any').join('space', 'S_pub', 'a_any');
  check('an unknown action is denied on a workspace', w.can('a_any', 'nuke', 'workspace', 'W'), false);
  check('an unknown action is denied on a space',     w.can('a_any', 'nuke', 'space', 'S_pub'), false);
  check('an unknown action is denied on a chat',      w.can('a_any', 'nuke', 'chat', 'C_pub'), false);
  check('an unknown action is denied on an agent',    w.can('a_any', 'nuke', 'agent', 'A'), false);
  check('an unknown object type is denied',           w.can('a_any', 'read', 'planet', 'Mars'), false);
  // Derived, not counted by hand — a hardcoded total silently rots the moment
  // an action is added, which is the opposite of a closed vocabulary's purpose.
  check('the vocabulary is exactly what §6 declares',
        Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, v.length])),
        { workspace: 6, space: 7, chat: 5, agent: 4 });
}

// ─── summary ─────────────────────────────────────────────────────────────────
const { pass, fail, fails } = results();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failing:', fails.join(', ')); process.exit(1); }
