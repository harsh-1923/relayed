// Executable model of Relayed authorization (docs/AUTHZ.md).
//
// The document rests on ONE claim: that the access rules can be evaluated
// either directly, as the SQL a server would write today, or as relationship
// tuples of the kind a Zanzibar-derived engine stores — and that the two agree
// on every input. If they diverge, deferring FGA (AUTHZ §10) is wishful
// thinking, and it is far cheaper to learn that here than in Phase 6.
//
// So this file deliberately contains TWO implementations of the same rules.
// That duplication is the experiment, not an accident.
//   node spikes/authz-tests.mjs

// ─── tiny test harness (same shape as sync-model.mjs) ────────────────────────
let pass = 0, fail = 0; const fails = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function check(name, actual, expected) {
  if (eq(actual, expected)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; fails.push(name);
    console.log(`  FAIL ${name}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`); }
}
export const section = s => console.log(`\n${s}`);
export const results = () => ({ pass, fail, fails });

// ─── the closed vocabularies (AUTHZ §6) ──────────────────────────────────────
export const ROLES = ['owner', 'admin', 'member'];
export const ACTIONS = {
  // `edit`: the workspace's own name and logo (FILES.md §11) — its admins'.
  workspace: ['invite', 'manage_members', 'create_space', 'transfer_ownership', 'create_agent', 'edit'],
  space:     ['read', 'join', 'add_member', 'remove_member', 'create_chat',
              'make_public', 'promote'],
  chat:      ['read', 'post', 'edit_own', 'delete_own', 'delete_any'],
  // WORKSPACE-AGENTS.md §4.4. `invoke` is derived from chat `post`, never stored.
  agent:     ['edit', 'manage_maintainers', 'deactivate', 'read_definition'],
};

// ─── the world ───────────────────────────────────────────────────────────────
export class World {
  constructor() {
    this.workspaces = new Map();  // id -> {}
    this.spaces = new Map();      // id -> { workspaceId, visibility }
    this.chats = new Map();       // id -> { spaceId, kind }
    this.agents = new Map();      // actor id -> { workspaceId }
    /** The single source of truth. AUTHZ §4: a permission is a row here. */
    this.memberships = [];        // { scopeType, scopeId, actorId, role, leftAt }
    this.delegations = [];        // { agentId, principalId, chatId, action, expiresAt }
  }
  workspace(id) { this.workspaces.set(id, {}); return id; }
  space(id, workspaceId, visibility = 'public') {
    this.spaces.set(id, { workspaceId, visibility }); return id;
  }
  chat(id, spaceId, kind = 'public') { this.chats.set(id, { spaceId, kind }); return id; }
  agent(id, workspaceId) { this.agents.set(id, { workspaceId }); return id; }

  join(scopeType, scopeId, actorId, role = 'member') {
    this.memberships.push({ scopeType, scopeId, actorId, role, leftAt: null });
    return this;
  }
  /** Leaving is a tombstone, never a delete — same discipline as §6.3 actors. */
  leave(scopeType, scopeId, actorId, at = 1) {
    for (const m of this.memberships) {
      if (m.scopeType === scopeType && m.scopeId === scopeId
          && m.actorId === actorId && m.leftAt === null) m.leftAt = at;
    }
    return this;
  }
  promote(scopeType, scopeId, actorId, role) {
    const before = JSON.stringify(this.memberships);
    for (const m of this.memberships) {
      if (m.scopeType === scopeType && m.scopeId === scopeId
          && m.actorId === actorId && m.leftAt === null) m.role = role;
    }
    return { changed: before !== JSON.stringify(this.memberships) };
  }
  delegate(agentId, principalId, chatId, action, expiresAt) {
    this.delegations.push({ agentId, principalId, chatId, action, expiresAt });
    return this;
  }

  #row(scopeType, scopeId, actorId) {
    return this.memberships.find(m => m.scopeType === scopeType && m.scopeId === scopeId
                                   && m.actorId === actorId && m.leftAt === null) ?? null;
  }

  // ── IMPLEMENTATION A: direct. What a server writes today. ─────────────────
  can(actorId, action, objectType, objectId, now = 0) {
    if (objectType === 'workspace') {
      const m = this.#row('workspace', objectId, actorId);
      if (!m) return false;
      switch (action) {
        case 'invite':
        case 'manage_members':
        case 'edit':                return m.role === 'admin' || m.role === 'owner';
        case 'transfer_ownership':  return m.role === 'owner';
        case 'create_space':
        case 'create_agent':        return true;
        default: return false;
      }
    }

    if (objectType === 'agent') {
      const agent = this.agents.get(objectId);
      if (!agent) return false;
      // Containment first, as for a space.
      const ws = this.#row('workspace', agent.workspaceId, actorId);
      if (!ws) return false;
      switch (action) {
        case 'read_definition': return true;
        // The one reach of a workspace role into an object: an agent spends
        // other people's authority, so an accountable admin can always stop it.
        case 'edit':
        case 'manage_maintainers':
        case 'deactivate':
          return this.#row('agent', objectId, actorId)?.role === 'admin'
              || ws.role === 'admin' || ws.role === 'owner';
        default: return false;
      }
    }

    if (objectType === 'space') {
      const space = this.spaces.get(objectId);
      if (!space) return false;
      // AUTHZ §7: space membership REQUIRES workspace membership. A workspace
      // role grants nothing here — no admin inheritance (invariant 51).
      if (!this.#row('workspace', space.workspaceId, actorId)) return false;
      // Joining is how membership BEGINS, so it is decided ABOVE the membership
      // test rather than below it — requiring membership would make every
      // public space unjoinable.
      if (action === 'join') return space.visibility === 'public';
      const m = this.#row('space', objectId, actorId);
      if (!m) return false;
      switch (action) {
        case 'read':
        case 'add_member':
        case 'create_chat':  return true;
        case 'make_public':
        case 'promote':
        case 'remove_member': return m.role === 'admin';
        default: return false;
      }
    }

    if (objectType === 'chat') {
      const chat = this.chats.get(objectId);
      if (!chat) return false;
      // The §7.3 access predicate, leading conjunct first (invariant 50).
      const inSpace = this.can(actorId, 'read', 'space', chat.spaceId, now);
      if (!inSpace) return false;
      const inChat = chat.kind !== 'private' || this.#row('chat', objectId, actorId) !== null;
      if (!inChat) return false;
      if (action === 'delete_any') {
        const m = this.#row('space', chat.spaceId, actorId);
        return m?.role === 'admin';
      }
      return ACTIONS.chat.includes(action);
    }
    return false;
  }

  /**
   * Delegation (DESIGN §6.4). The intersection is the whole point: an agent may
   * do only what BOTH it and its principal may do, in THIS chat, right now.
   */
  canAsAgent(agentId, principalId, action, chatId, now = 0) {
    const grant = this.delegations.find(d =>
      d.agentId === agentId && d.principalId === principalId
      && d.chatId === chatId && d.action === action);
    if (!grant || now >= grant.expiresAt) return false;
    return this.can(agentId, action, 'chat', chatId, now)
        && this.can(principalId, action, 'chat', chatId, now);
  }

  // ── IMPLEMENTATION B: tuples. What an FGA engine would hold. ──────────────
  /** Every membership as (subject, relation, object) — AUTHZ §4. */
  tuples() {
    return this.memberships
      .filter(m => m.leftAt === null)
      .map(m => ({ subject: `actor:${m.actorId}`,
                   relation: m.role,
                   object: `${m.scopeType}:${m.scopeId}` }));
  }

  /**
   * Evaluated purely from tuples plus the derivation rules in AUTHZ §7 —
   * no object columns, no application branching on identity.
   */
  checkTuple(actorId, action, objectType, objectId, now = 0) {
    const t = this.tuples();
    const has = (obj, roles) => t.some(x => x.subject === `actor:${actorId}`
                                         && x.object === obj
                                         && roles.includes(x.relation));
    const anyRole = ROLES;

    if (objectType === 'workspace') {
      const obj = `workspace:${objectId}`;
      if (!has(obj, anyRole)) return false;
      if (action === 'invite' || action === 'manage_members' || action === 'edit') return has(obj, ['admin', 'owner']);
      if (action === 'transfer_ownership') return has(obj, ['owner']);
      if (action === 'create_space' || action === 'create_agent') return true;
      return false;
    }

    if (objectType === 'agent') {
      const agent = this.agents.get(objectId);
      if (!agent) return false;
      const parent = `workspace:${agent.workspaceId}`;
      if (!has(parent, anyRole)) return false;
      if (action === 'read_definition') return true;
      if (['edit', 'manage_maintainers', 'deactivate'].includes(action)) {
        // tuple-to-userset: the agent's admins, plus the parent's admins.
        return has(`agent:${objectId}`, ['admin']) || has(parent, ['admin', 'owner']);
      }
      return false;
    }

    if (objectType === 'space') {
      const space = this.spaces.get(objectId);
      if (!space) return false;
      // tuple-to-userset: membership of the parent, reached through containment
      if (!has(`workspace:${space.workspaceId}`, anyRole)) return false;
      // Joining is how membership BEGINS, so it cannot require membership. The
      // space's own policy decides it, above the membership test rather than
      // below it.
      if (action === 'join') return space.visibility === 'public';
      const obj = `space:${objectId}`;
      if (!has(obj, anyRole)) return false;
      if (action === 'make_public' || action === 'promote'
          || action === 'remove_member') return has(obj, ['admin']);
      return ['read', 'add_member', 'create_chat'].includes(action);
    }

    if (objectType === 'chat') {
      const chat = this.chats.get(objectId);
      if (!chat) return false;
      if (!this.checkTuple(actorId, 'read', 'space', chat.spaceId, now)) return false;
      if (chat.kind === 'private' && !has(`chat:${objectId}`, anyRole)) return false;
      if (action === 'delete_any') return has(`space:${chat.spaceId}`, ['admin']);
      return ACTIONS.chat.includes(action);
    }
    return false;
  }
}

/** Every (actor, action, object) triple in a world — the equivalence domain. */
export function everyCheck(world, actors) {
  const out = [];
  for (const a of actors) {
    for (const w of world.workspaces.keys())
      for (const action of ACTIONS.workspace) out.push([a, action, 'workspace', w]);
    for (const s of world.spaces.keys())
      for (const action of ACTIONS.space) out.push([a, action, 'space', s]);
    for (const c of world.chats.keys())
      for (const action of ACTIONS.chat) out.push([a, action, 'chat', c]);
    for (const g of world.agents.keys())
      for (const action of ACTIONS.agent) out.push([a, action, 'agent', g]);
  }
  return out;
}
