// The local mirror of WorkOS organization memberships.
//
// `workos_memberships` is the authority on who has been ADMITTED to an org
// (004_workos_events.sql) — and, since orgs hold several workspaces, on who is
// an org MEMBER at all (ORG-DOMAINS.md §6). Two writers:
//
//   the poller   every event WorkOS reports, within a poll interval
//   ourselves    the moment we call `addMember`, so the person is visible to
//                everything reading the mirror immediately rather than up to
//                30 s later — the lag the org-domains spike measured (check 4.1)
//
// Both upsert, so the event arriving after our own write lands on the same row.
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '../db/schema.ts';

export async function recordWorkosMembership(
  db: Kysely<DB>, workosUserId: string, workosOrgId: string,
  status = 'active', roleSlug: string | null = null,
): Promise<void> {
  await db.insertInto('workos_memberships').values({
    workos_user_id: workosUserId, workos_org_id: workosOrgId, role_slug: roleSlug, status,
  }).onConflict((oc) => oc.columns(['workos_user_id', 'workos_org_id']).doUpdateSet({
    role_slug: roleSlug, status, seen_at: sql`now()`,
  })).execute();
}

/** Is this identity an active member of this org, per the mirror? */
export async function isOrgMember(db: Kysely<DB>, workosUserId: string, orgId: string): Promise<boolean> {
  const row = await db.selectFrom('workos_memberships')
    .innerJoin('organizations', 'organizations.workos_org_id', 'workos_memberships.workos_org_id')
    .select('organizations.id')
    .where('workos_memberships.workos_user_id', '=', workosUserId)
    .where('workos_memberships.status', '=', 'active')
    .where('organizations.id', '=', orgId)
    .executeTakeFirst();
  return !!row;
}
