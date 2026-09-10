// Joining a workspace you were invited to (PHASE-1-IDENTITY.md §9 decision 2).
//
// WorkOS owns acceptance, not us. The invitation email links to AuthKit's hosted
// page — `accept_invitation_url` is on the authkit.app domain — so by the time
// someone reaches our app the OrganizationMembership already exists and we were
// never asked. That rules out an accept endpoint of our own and makes this
// reconciliation: at sign-in, find the organizations WorkOS says they belong to
// that we have no actor for.
//
// The actor is NOT created here. A new actor needs a handle, handles are per
// workspace, and this is the first point where one can already be taken — so
// the client is told what is pending and the person chooses (AUTHZ.md §9).
import type { Kysely } from 'kysely';
import { emit, count } from '@relayed/telemetry';
import type { DB } from '../db/schema.ts';
import { ulid } from '../db/ulid.ts';
import { listMemberships } from '../workos/management.ts';
import { recordActor } from '../sync/directory.ts';
import { suggestHandles, type Identity } from './provision.ts';

export interface PendingJoin {
  orgId: string;
  workspaceId: string;
  name: string;
  handleSuggestions: string[];
}

/**
 * Workspaces this identity has been admitted to in WorkOS but has no actor for.
 *
 * Two sources, chosen by the caller:
 *
 *   'live'   ask WorkOS. Authoritative, and the correctness backstop — a fresh
 *            install has no local mirror, and the poller may not have run.
 *            Used at interactive sign-in, which is rare.
 *   'mirror' read what the poller has already seen. Free, so it can run on
 *            every refresh — which is what lets someone who accepts an
 *            invitation while signed in see it without signing out.
 *
 * Never throws. WorkOS being unreachable must degrade to "no pending
 * invitations" rather than failing a sign-in that has otherwise succeeded.
 */
export async function pendingJoins(
  db: Kysely<DB>, id: Identity, source: 'live' | 'mirror' = 'live',
): Promise<PendingJoin[]> {
  let workosOrgIds: string[];
  if (source === 'mirror') {
    const rows = await db.selectFrom('workos_memberships').select('workos_org_id')
      .where('workos_user_id', '=', id.workosUserId)
      .where('status', '=', 'active').execute();
    workosOrgIds = rows.map(r => r.workos_org_id);
  } else {
    try {
      const res = await listMemberships(id.workosUserId);
      workosOrgIds = res.data.map(m => m.organization_id);
    } catch {
      return [];
    }
  }
  if (workosOrgIds.length === 0) return [];

  const rows = await db.selectFrom('organizations')
    .innerJoin('workspaces', 'workspaces.org_id', 'organizations.id')
    .leftJoin('actors', (join) => join
      .onRef('actors.workspace_id', '=', 'workspaces.id')
      .on('actors.identity_kind', '=', 'workos_user')
      .on('actors.identity_id', '=', id.workosUserId))
    .select(['organizations.id as org_id', 'workspaces.id as workspace_id',
             'workspaces.name as name', 'actors.id as actor_id'])
    .where('organizations.workos_org_id', 'in', workosOrgIds)
    .execute();

  const joins: PendingJoin[] = [];
  for (const r of rows) {
    if (r.actor_id) continue;   // already a member here
    joins.push({
      orgId: r.org_id, workspaceId: r.workspace_id, name: r.name,
      handleSuggestions: (await suggestHandles(db, r.workspace_id, id)).slice(0, 5),
    });
  }
  return joins;
}

export interface Joined {
  actorId: string;
  orgId: string;
  workspaceId: string;
}

/**
 * Materialise the actor, with the handle they chose.
 *
 * Verifies the WorkOS membership again rather than trusting the client's
 * word for it: `workspace_id` arrives in a request body, and a request body is
 * not evidence of an invitation.
 */
export async function joinWorkspace(
  db: Kysely<DB>, id: Identity, workspaceId: string, handle: string,
): Promise<Joined | 'not_invited' | 'handle_taken'> {
  const target = await db.selectFrom('workspaces')
    .innerJoin('organizations', 'organizations.id', 'workspaces.org_id')
    .select(['workspaces.id as workspace_id', 'workspaces.org_id as org_id',
             'organizations.workos_org_id as workos_org_id'])
    .where('workspaces.id', '=', workspaceId)
    .executeTakeFirst();
  if (!target) return 'not_invited';

  let admitted = false;
  try {
    const res = await listMemberships(id.workosUserId);
    admitted = res.data.some(m => m.organization_id === target.workos_org_id);
  } catch {
    // Unreachable is not the same as unauthorised, but it cannot be treated as
    // permission either — the person retries.
    return 'not_invited';
  }
  if (!admitted) return 'not_invited';

  const clash = await db.selectFrom('actors').select('id')
    .where('workspace_id', '=', workspaceId)
    .where((eb) => eb(eb.fn('lower', ['handle']), '=', handle.toLowerCase()))
    .executeTakeFirst();
  if (clash) {
    // The first point in the product where a handle can already be taken:
    // a new workspace has an empty namespace, so this is only reachable by
    // joining an existing one. The metric was reserved for exactly here.
    count('handle.collision');
    return 'handle_taken';
  }

  const actorId = ulid('act');
  await db.transaction().execute(async (tx) => {
    await tx.insertInto('actors').values({
      id: actorId, org_id: target.org_id, workspace_id: workspaceId,
      type: 'human', handle, display_name: id.displayName, avatar_url: id.avatarUrl,
      identity_kind: 'workos_user', identity_id: id.workosUserId,
      owner_actor_id: null, provisioned_by: 'invite', state: 'active',
    }).execute();

    // Every existing member of this workspace learns about the new arrival from
    // this one event — one row on each client, rather than a re-send of the
    // whole directory. That difference is the entire reason the directory is a
    // stream (docs/SYNC-FLOWS.md §9.1).
    await recordActor(tx, 'actor.created', {
      id: actorId, workspaceId, type: 'human', handle,
      displayName: id.displayName, avatarUrl: id.avatarUrl, state: 'active',
    });

    // A member, not an admin. Being invited grants belonging, never authority
    // (AUTHZ.md §6) — a new joiner who could immediately invite would make the
    // admin gate on invite meaningless.
    await tx.insertInto('memberships').values({
      scope_type: 'workspace', scope_id: workspaceId,
      actor_id: actorId, role: 'member', left_at: null,
    }).execute();
  });

  count('identity.provisioned', { via: 'invite' });
  emit('identity.provisioned', {
    actor: actorId, org: target.org_id, workspace: workspaceId, via: 'invite',
  });
  return { actorId, orgId: target.org_id, workspaceId };
}
