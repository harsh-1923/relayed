// The evaluator (docs/AUTHZ.md §7).
//
// Deliberately PURE: grants and placement in, boolean out. No database, no
// fetch, no clock.
//
// That is not tidiness — it is what lets the same function run on the server,
// where it is authoritative, and in the client, where it must answer offline
// (§3). An evaluator that needed IO could not be mirrored, and a mirror that
// was a second implementation would drift from the original the first time
// either changed.
import { REQUIRES, atLeast, isAction, type Role, type Scope, type Target } from './model.ts';

/** Every membership an actor holds, keyed `scope:id`. */
export type Grants = ReadonlyMap<string, Role>;

export const grantKey = (scope: Scope, id: string): string => `${scope}:${id}`;

/**
 * Where objects sit in the containment hierarchy (§5), plus the two facts that
 * are properties of the object rather than of a membership.
 *
 * Passed in rather than looked up, for the same reason the evaluator is pure.
 */
export interface Placement {
  /** chat id -> space id */
  spaceOf?: Readonly<Record<string, string>>;
  /** space id -> workspace id */
  workspaceOf?: Readonly<Record<string, string>>;
  privateChats?: ReadonlySet<string>;
  /**
   * Spaces anyone in the workspace may join without being invited — a public
   * channel or a public room (DESIGN.md §7.2).
   *
   * A property of the object rather than of a membership, like `privateChats`
   * above, and here for the same reason: `join` is the one action whose answer
   * cannot come from the asker's grants, because the grant is what it creates.
   */
  openSpaces?: ReadonlySet<string>;
}

/** Can `actor` (described by `grants`) perform `action` on `target`? */
export function can(
  grants: Grants, action: string, target: Target, placement: Placement = {},
): boolean {
  const { scope, id } = target;
  // A vocabulary closed only by convention is not closed. Unknown is denied,
  // never defaulted — including an action that is valid on a different scope.
  if (!isAction(scope, action)) return false;
  const needed = REQUIRES[`${scope}:${action}`];
  if (needed === undefined) return false;

  if (scope === 'workspace') return holds(grants, 'workspace', id, needed);

  if (scope === 'space') {
    const ws = placement.workspaceOf?.[id];
    // Containment: a space membership without the workspace membership above it
    // grants nothing. The leading conjunct, one level up.
    if (!ws || !grants.has(grantKey('workspace', ws))) return false;
    // Joining is deliberately NOT a membership test — it is how membership
    // begins, so requiring it would make every public space unjoinable. The
    // workspace conjunct above still holds, and the space's own policy decides
    // the rest: public means discoverable and joinable, private means invited.
    if (action === 'join') return placement.openSpaces?.has(id) ?? false;
    return holds(grants, 'space', id, needed);
  }

  const spaceId = placement.spaceOf?.[id];
  if (!spaceId) return false;
  // §7.3's access predicate, leading conjunct first: space membership is a
  // structural precondition, so an actor removed from a space cannot retain a
  // private chat inside it and nobody has to sweep chat rows (invariant 50).
  if (!can(grants, 'read', { scope: 'space', id: spaceId }, placement)) return false;
  if (placement.privateChats?.has(id) && !grants.has(grantKey('chat', id))) return false;

  // Moderation is a SPACE power exercised in a chat — the admin row lives one
  // level up, which is why this is not a plain role comparison.
  if (action === 'delete_any') return holds(grants, 'space', spaceId, 'admin');
  return true;
}

function holds(grants: Grants, scope: Scope, id: string, needed: Role | null): boolean {
  const role = grants.get(grantKey(scope, id));
  if (!role) return false;
  return needed === null || atLeast(role, needed);
}
