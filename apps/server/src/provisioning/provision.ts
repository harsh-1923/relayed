// First sign-in provisioning (PHASE-1-IDENTITY.md §9).
//
// Organizations are created ON DEMAND, never on signup: someone arriving via an
// invite lands in that workspace and gets no personal org at all. Auto-creating
// one would make multi-org the default state and, worse, drop invited users
// into an empty workspace of their own — which reads as a broken invite.
import type { Kysely } from 'kysely';
import { ulid } from '../db/ulid.ts';
import type { DB } from '../db/schema.ts';
import { handleCandidates } from './handle.ts';

export interface Identity {
  workosUserId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface Resolved {
  actorId: string;
  orgId: string;
  workspaceId: string;
  /** True when the caller must run onboarding: no org exists for this identity. */
  needsWorkspace: boolean;
  handleSuggestions: string[];
}

/** One workspace this identity belongs to. The client caches these (STORAGE.md §6). */
export interface Membership {
  actorId: string;
  orgId: string;
  workspaceId: string;
  name: string;
  slug: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * EVERY workspace this identity belongs to, oldest first.
 *
 * One WorkOS user can hold several OrganizationMemberships — accepting an
 * invite on an email that already has an org is the ordinary way it happens —
 * and our unique index is (workspace_id, identity_kind, identity_id), so two
 * actors for one identity is a correct state, not a conflict.
 *
 * The ordering is load-bearing. This previously took the first row of an
 * unordered query, which returns an arbitrary actor once there are two:
 * repeatable in testing, undefined by contract, and free to change after a
 * vacuum or an index change (STORAGE.md §10.1).
 */
export async function resolveMemberships(
  db: Kysely<DB>, workosUserId: string,
): Promise<Membership[]> {
  const rows = await db.selectFrom('actors')
    .innerJoin('workspaces', 'workspaces.id', 'actors.workspace_id')
    .select([
      'actors.id as actor_id', 'actors.org_id', 'actors.workspace_id',
      'actors.handle', 'actors.display_name', 'actors.avatar_url',
      'workspaces.name', 'workspaces.slug',
    ])
    .where('actors.identity_kind', '=', 'workos_user')
    .where('actors.identity_id', '=', workosUserId)
    .where('actors.state', 'not in', ['deactivated', 'suspended'])
    // ULIDs break a same-transaction timestamp tie deterministically.
    .orderBy('actors.created_at', 'asc')
    .orderBy('actors.id', 'asc')
    .execute();

  return rows.map(r => ({
    actorId: r.actor_id, orgId: r.org_id, workspaceId: r.workspace_id,
    name: r.name, slug: r.slug, handle: r.handle,
    displayName: r.display_name, avatarUrl: r.avatar_url,
  }));
}

/**
 * Which membership a new session is scoped to.
 *
 * `preferred` is the workspace the client had open (STORAGE.md §10.1); a fresh
 * install sends none and gets the oldest. A `preferred` that is not ours is an
 * error, never a silent fallback — quietly signing someone into a different
 * workspace than they asked for is worse than failing.
 */
export function selectMembership(
  memberships: readonly Membership[], preferred?: string,
): Membership | 'not_a_member' | null {
  if (memberships.length === 0) return null;
  if (!preferred) return memberships[0]!;
  return memberships.find(m => m.workspaceId === preferred) ?? 'not_a_member';
}

/** Find the existing actor for a WorkOS identity, or report that none exists. */
export async function resolveActor(db: Kysely<DB>, id: Identity): Promise<Resolved | null> {
  const first = (await resolveMemberships(db, id.workosUserId))[0];
  if (!first) return null;
  return {
    actorId: first.actorId, orgId: first.orgId, workspaceId: first.workspaceId,
    needsWorkspace: false, handleSuggestions: [],
  };
}

const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';

/**
 * Creates an organization, its single workspace, and the founding actor.
 * One transaction: a half-created tenant is worse than a failed sign-in.
 */
export async function createWorkspace(
  db: Kysely<DB>,
  id: Identity,
  opts: { workspaceName: string; handle: string },
): Promise<Resolved> {
  return db.transaction().execute(async (tx) => {
    const orgId = ulid('org');
    const workspaceId = ulid('wsp');
    const actorId = ulid('act');

    await tx.insertInto('organizations').values({
      id: orgId,
      // Until the Management API is wired, the WorkOS org link is our own id.
      // The column is UNIQUE NOT NULL so the shape stays honest.
      workos_org_id: `pending_${orgId}`,
      name: opts.workspaceName,
    }).execute();

    await tx.insertInto('workspaces').values({
      id: workspaceId, org_id: orgId,
      name: opts.workspaceName, slug: slugify(opts.workspaceName),
    }).execute();

    await tx.insertInto('actors').values({
      id: actorId, org_id: orgId, workspace_id: workspaceId,
      type: 'human', handle: opts.handle, display_name: id.displayName,
      avatar_url: id.avatarUrl,
      identity_kind: 'workos_user', identity_id: id.workosUserId,
      owner_actor_id: null, provisioned_by: 'self_signup', state: 'active',
    }).execute();

    return { actorId, orgId, workspaceId, needsWorkspace: false, handleSuggestions: [] };
  });
}

/** Suggestions for the onboarding form, filtered to what is actually free. */
export async function suggestHandles(
  db: Kysely<DB>, workspaceId: string, id: Identity,
): Promise<string[]> {
  const candidates = handleCandidates(id.email, id.displayName);
  if (candidates.length === 0) return [];
  const taken = new Set((await db.selectFrom('actors')
    .select('handle')
    .where('workspace_id', '=', workspaceId)
    .execute()).map(r => r.handle.toLowerCase()));
  return candidates.filter(c => !taken.has(c));
}
