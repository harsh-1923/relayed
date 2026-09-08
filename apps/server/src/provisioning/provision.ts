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

/** Find the existing actor for a WorkOS identity, or report that none exists. */
export async function resolveActor(db: Kysely<DB>, id: Identity): Promise<Resolved | null> {
  const actor = await db.selectFrom('actors')
    .select(['id', 'org_id', 'workspace_id'])
    .where('identity_kind', '=', 'workos_user')
    .where('identity_id', '=', id.workosUserId)
    .where('state', '!=', 'deactivated')
    .executeTakeFirst();
  if (!actor) return null;
  return {
    actorId: actor.id, orgId: actor.org_id, workspaceId: actor.workspace_id,
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
