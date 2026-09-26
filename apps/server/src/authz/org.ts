// Who governs an organization (docs/ORG-DOMAINS.md §6).
//
// NO ROLE TABLE, deliberately. An org admin is an `owner` or `admin` of the
// org's DEFAULT workspace — derived here, stored nowhere. The org-domains spike
// ran this rule against a stored `org_roles` table on every scenario it could
// build and got identical answers (check 5.2); the table's `member` rows had
// meanwhile drifted from the WorkOS mirror after two joins (check 5.3). What
// the derivation gets for free: an org always has an admin, because every
// workspace has exactly one owner (`membership_one_owner`), and a claimed org's
// admins stop being admins without a row being touched.
//
// Loaded separately from `loadGrants`, which runs on the socket's hot path and
// has no use for an org grant. The two meet only inside `can()`.
import type { Kysely } from 'kysely';
import { can, grantKey, organization, type Grants } from '@relayed/authz';
import type { DB } from '../db/schema.ts';

/** The orgs this identity is an admin of. */
export async function adminOrgs(db: Kysely<DB>, workosUserId: string): Promise<Set<string>> {
  const rows = await db.selectFrom('organizations')
    .innerJoin('actors', (join) => join
      .onRef('actors.workspace_id', '=', 'organizations.default_workspace_id')
      .on('actors.identity_kind', '=', 'workos_user')
      .on('actors.identity_id', '=', workosUserId)
      .on('actors.state', '=', 'active'))
    .innerJoin('memberships', (join) => join
      .onRef('memberships.actor_id', '=', 'actors.id')
      .on('memberships.scope_type', '=', 'workspace')
      .onRef('memberships.scope_id', '=', 'actors.workspace_id')
      .on('memberships.left_at', 'is', null))
    .select('organizations.id')
    .where('memberships.role', 'in', ['owner', 'admin'])
    .execute();
  return new Set(rows.map(r => r.id));
}

/** The derived grants, in the shape `can()` reads. */
export async function orgGrants(db: Kysely<DB>, workosUserId: string): Promise<Grants> {
  return new Map([...await adminOrgs(db, workosUserId)].map(id => [grantKey('organization', id), 'admin' as const]));
}

export type OrgAction = 'create_workspace' | 'manage_domains' | 'manage_workspaces' | 'edit';

export async function canOrg(
  db: Kysely<DB>, workosUserId: string, action: OrgAction, orgId: string,
): Promise<boolean> {
  return can(await orgGrants(db, workosUserId), action, organization(orgId));
}

/**
 * Is this identity an owner or admin of this workspace?
 *
 * Choosing a new default workspace changes who the org's admins are, so it is
 * only allowed to someone who will be one of them afterwards (§6, §16 q3).
 */
export async function adminsWorkspace(
  db: Kysely<DB>, workosUserId: string, workspaceId: string,
): Promise<boolean> {
  const row = await db.selectFrom('actors')
    .innerJoin('memberships', (join) => join
      .onRef('memberships.actor_id', '=', 'actors.id')
      .on('memberships.scope_type', '=', 'workspace')
      .onRef('memberships.scope_id', '=', 'actors.workspace_id')
      .on('memberships.left_at', 'is', null))
    .select('actors.id')
    .where('actors.workspace_id', '=', workspaceId)
    .where('actors.identity_kind', '=', 'workos_user')
    .where('actors.identity_id', '=', workosUserId)
    .where('actors.state', '=', 'active')
    .where('memberships.role', 'in', ['owner', 'admin'])
    .executeTakeFirst();
  return !!row;
}
