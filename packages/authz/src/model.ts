// The authorization vocabulary (docs/AUTHZ.md §6).
//
// Both sets are CLOSED, and closed is the point: they are the relation set an
// FGA model would declare, so keeping them closed is what makes §10's migration
// a change of evaluator rather than a change of model. An action that exists
// only as a string in a route is one that cannot be modelled later.

export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

/** Higher wins. Used only for comparison, never stored — the row holds a name. */
const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };
export const atLeast = (held: Role, needed: Role): boolean => RANK[held] >= RANK[needed];

/**
 * `agent` is an OBJECT, not a level of the containment hierarchy: an agent sits
 * directly in its workspace, beside spaces rather than inside one, and its
 * admin rows are its maintainers (WORKSPACE-AGENTS.md §4.4). Invoking one is not
 * an action here at all — it is derived from `post` in a chat whose space the
 * agent belongs to, and never stored.
 */
export const SCOPES = ['workspace', 'space', 'chat', 'agent'] as const;
export type Scope = (typeof SCOPES)[number];

export const ACTIONS = {
  workspace: ['invite', 'manage_members', 'create_space', 'transfer_ownership', 'create_agent'],
  space:     ['read', 'join', 'add_member', 'remove_member', 'create_chat',
              'make_public', 'promote'],
  chat:      ['read', 'post', 'edit_own', 'delete_own', 'delete_any'],
  agent:     ['edit', 'manage_maintainers', 'deactivate', 'read_definition'],
} as const;

export type Action<S extends Scope = Scope> = (typeof ACTIONS)[S][number];

/** What an actor is being asked about. Scope and id travel together, always. */
export interface Target<S extends Scope = Scope> {
  scope: S;
  id: string;
}

export const workspace = (id: string): Target<'workspace'> => ({ scope: 'workspace', id });
export const space     = (id: string): Target<'space'>     => ({ scope: 'space', id });
export const chat      = (id: string): Target<'chat'>      => ({ scope: 'chat', id });
export const agent     = (id: string): Target<'agent'>     => ({ scope: 'agent', id });

/**
 * The minimum role an action needs at its own scope. `null` means membership
 * alone suffices — which is most of them, deliberately (§6).
 *
 * Derived rules that are NOT a role comparison — containment, the private-chat
 * conjunct, authorship — live in `can()` and are named there.
 */
export const REQUIRES: Record<string, Role | null> = {
  'workspace:invite':              'admin',
  'workspace:manage_members':      'admin',
  'workspace:transfer_ownership':  'owner',
  'workspace:create_space':        null,
  // Any member, deliberately. The risk a creator poses is an agent misusing
  // its INVOKERS' accounts, and that is closed by each invoker's permission —
  // not by who typed the instructions (WORKSPACE-AGENTS.md §4.4).
  'workspace:create_agent':        null,

  'space:read':          null,
  // Joining is the ONE space action that cannot require space membership —
  // membership is what it creates. `null` here means "no role needed"; the real
  // gate is the space's own policy, and can() applies it (§6).
  'space:join':          null,
  'space:add_member':    null,   // deliberate asymmetry with make_public (§6)
  // Removing SOMEBODY ELSE is moderation. Leaving is not this action at all —
  // an actor removing themselves needs no permission and never reaches here.
  'space:remove_member': 'admin',
  'space:create_chat':   null,
  'space:make_public':   'admin',
  'space:promote':       'admin',

  'chat:read':        null,
  'chat:post':        null,
  'chat:edit_own':    null,
  'chat:delete_own':  null,
  'chat:delete_any':  'admin',  // at the SPACE, not the chat — see can()

  // An agent's admins are its maintainers. A WORKSPACE admin also passes these
  // three — the one place a workspace role reaches an object below it; see can().
  'agent:edit':               'admin',
  'agent:manage_maintainers': 'admin',
  'agent:deactivate':         'admin',
  // Everyone in the workspace reads what an agent was told: it spends each
  // invoker's authority, so nobody spending it may be kept from its prompt.
  'agent:read_definition':    null,
};

export const isAction = (scope: Scope, action: string): boolean =>
  (ACTIONS[scope] as readonly string[]).includes(action);
