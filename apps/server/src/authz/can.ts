// The one place a permission is decided, server-side (docs/AUTHZ.md §7).
//
// No route, handler or query may test a role directly. `if (actor.role ===
// 'admin')` inlined at a call site is precisely what turns §10's migration from
// a file into a rewrite, and it is what makes two call sites drift until no two
// agree. This rule is the entire price of keeping FGA optional, and it is worth
// paying while there are two call sites rather than fifty.
//
// This is also the ONLY authoritative evaluation. The client has a mirror, but
// the client may only hide what it believes is denied — it never grants
// (invariant 49), because it is a distributable binary on a machine we do not
// control.
import type { Kysely } from 'kysely';
import { can, grantKey, type Grants, type Placement } from '@relayed/authz';
import type { Action, Role, Scope, Target } from '@relayed/authz';
import type { DB } from '../db/schema.ts';

export { can, workspace } from '@relayed/authz';
export type { Grants, Placement } from '@relayed/authz';

/**
 * Every membership an actor holds.
 *
 * Loaded once per request rather than queried per check: a handler asking three
 * questions about the same actor should not make three round trips, and the
 * answers must not be able to disagree with each other mid-request.
 */
export async function loadGrants(db: Kysely<DB>, actorId: string): Promise<Grants> {
  const rows = await db.selectFrom('memberships')
    .select(['scope_type', 'scope_id', 'role'])
    .where('actor_id', '=', actorId)
    .where('left_at', 'is', null)
    .execute();
  return new Map(rows.map(r => [grantKey(r.scope_type as Scope, r.scope_id), r.role as Role]));
}

/** Convenience for the common server shape: load, then ask once. */
export async function canDb(
  db: Kysely<DB>, actorId: string, action: string, target: Target, placement?: Placement,
): Promise<boolean> {
  return can(await loadGrants(db, actorId), action, target, placement);
}

/** Thrown by routes; mapped to 403 in one place rather than at every call site. */
export class Forbidden extends Error {
  readonly action: string;
  readonly target: Target;
  constructor(action: string, target: Target) {
    super(`forbidden: ${action} on ${target.scope}:${target.id}`);
    this.name = 'Forbidden';
    this.action = action;
    this.target = target;
  }
}

export async function requireCan(
  db: Kysely<DB>, actorId: string, action: Action, target: Target, placement?: Placement,
): Promise<void> {
  if (!await canDb(db, actorId, action, target, placement)) throw new Forbidden(action, target);
}
