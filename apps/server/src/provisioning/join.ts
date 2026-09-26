// Joining a workspace you were invited to, or that your company opened to you
// (PHASE-1-IDENTITY.md §9 decision 2, ORG-DOMAINS.md §5).
//
// WorkOS owns acceptance, not us. The invitation email links to AuthKit's hosted
// page — `accept_invitation_url` is on the authkit.app domain — so by the time
// someone reaches our app the OrganizationMembership already exists and we were
// never asked. That rules out an accept endpoint of our own and makes this
// reconciliation: at sign-in, find what WorkOS says they belong to that we have
// no actor for.
//
// SEVERAL WORKSPACES PER ORG changed what "belongs to" means. A WorkOS
// membership is org-wide, so it can no longer be read as permission to enter
// every workspace of the org — the org-domains spike had an ordinary member
// offered, and admitted to, an invite-only workspace (checks 2.2, 2.3). An org
// member now enters a workspace only when it is open to the org, or when they
// were invited to THAT workspace (`admissible`, below). Both the offer and the
// join ask the same function, so they cannot disagree.
//
// The actor is NOT created until the person chooses: a new actor needs a
// handle, handles are per workspace, and this is the first point where one can
// already be taken (AUTHZ.md §9).
import { sql, type Kysely } from 'kysely';
import { emit, count } from '@relayed/telemetry';
import type { DB } from '../db/schema.ts';
import { ulid } from '../db/ulid.ts';
import { addMember, listInvitations, listMemberships } from '../workos/management.ts';
import { recordWorkosMembership } from '../workos/mirror.ts';
import { recordActor } from '../sync/directory.ts';
import { suggestHandles, type Identity } from './provision.ts';
import { domainAdmits, domainOf, syncWorkosDomains, verifiedDomains } from './domains.ts';

export interface PendingJoin {
  orgId: string;
  workspaceId: string;
  name: string;
  handleSuggestions: string[];
  /**
   * WHY it is offered, so the client can say so honestly:
   *   invited   an invitation to this workspace was accepted
   *   company   in the org because their email's domain is verified on it in
   *             WorkOS, which adds every matching sign-in by itself (§11)
   *   member    in the org some other way — an invitation to another of its
   *             workspaces, say
   */
  reason: 'invited' | 'company' | 'member';
  /** Its logo — its own, else its org's — as a relative `/files/…` URL, or null (FILES.md §5). */
  logoUrl: string | null;
  /** The org's default workspace — where colleagues land. */
  isDefault: boolean;
  /** Its organization's name — the join list is titled by it. */
  orgName: string;
  /** Active people in THIS workspace. */
  memberCount: number;
  /** Invite-only: offered only because they were invited to it. */
  inviteOnly: boolean;
}

/**
 * Learn which invitations this person has accepted, from WorkOS.
 *
 * WorkOS records `accepted_user_id` on an invitation; we record which
 * workspace it was sent from (`workspace_invitations`). Joining the two here,
 * once, means every later check — the refresh path included — reads our own
 * table instead of asking WorkOS again. Never throws: an unreachable WorkOS
 * leaves what we already knew.
 */
export async function learnAcceptedInvitations(
  db: Kysely<DB>, workosUserId: string, workosOrgIds: readonly string[],
): Promise<void> {
  for (const orgId of workosOrgIds) {
    let accepted: string[];
    try {
      const res = await listInvitations(orgId);
      accepted = res.data.filter(i => i.accepted_user_id === workosUserId).map(i => i.id);
    } catch { continue; }
    if (accepted.length === 0) continue;
    await db.updateTable('workspace_invitations').set({ accepted_user_id: workosUserId })
      .where('workos_invitation_id', 'in', accepted)
      .where('accepted_user_id', 'is', null).execute();
  }
}

/** Workspaces this person accepted an invitation into, as far as we know. */
async function invitedTo(db: Kysely<DB>, workosUserId: string): Promise<Set<string>> {
  const rows = await db.selectFrom('workspace_invitations').select('workspace_id')
    .where('accepted_user_id', '=', workosUserId).execute();
  return new Set(rows.map(r => r.workspace_id));
}

/**
 * May an ORG MEMBER enter this workspace? Open to the org, or invited here.
 *
 * The one rule behind both the offer (`pendingJoins`) and the join itself. A
 * pre-migration invitation has no `workspace_invitations` row; its org then
 * held a single workspace, now its default, which is open — so it still lands
 * where it was meant to.
 */
function admissible(ws: { id: string; join_policy: string }, invited: ReadonlySet<string>): boolean {
  return ws.join_policy === 'org_open' || invited.has(ws.id);
}

/**
 * Workspaces this identity may enter and has no actor in.
 *
 * Two sources for org membership, chosen by the caller:
 *
 *   'live'   ask WorkOS. Authoritative, and the correctness backstop — a fresh
 *            install has no local mirror, and the poller may not have run.
 *            Used at interactive sign-in, which is rare. Also refreshes which
 *            invitations were accepted.
 *   'mirror' read what the poller has already seen. Free, so it can run on
 *            every refresh — which is what lets someone who accepts an
 *            invitation while signed in see it without signing out.
 *
 * What is OFFERED, per org the person belongs to:
 *   - every workspace they were invited into, and
 *   - if they have no workspace in that org yet, EVERY workspace open to it,
 *     default first — arriving is when "what is here for me" is asked.
 * Once they are in the org, its other open workspaces are for *Browse* and
 * stop being pending: otherwise the switcher would count them forever.
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
    await learnAcceptedInvitations(db, id.workosUserId, workosOrgIds);
    // Which of these orgs WorkOS routes people into by domain — so the offer
    // can say "your company", and the org's page shows it (§11).
    await syncWorkosDomains(db, workosOrgIds);
  }
  if (workosOrgIds.length === 0) return [];

  const rows = await db.selectFrom('organizations')
    .innerJoin('workspaces', 'workspaces.org_id', 'organizations.id')
    .leftJoin('actors', (join) => join
      .onRef('actors.workspace_id', '=', 'workspaces.id')
      .on('actors.identity_kind', '=', 'workos_user')
      .on('actors.identity_id', '=', id.workosUserId))
    .select((eb) => ['organizations.id as org_id', 'organizations.default_workspace_id',
             'organizations.name as org_name',
             'workspaces.id as workspace_id', 'workspaces.name as name',
             'workspaces.join_policy', 'actors.id as actor_id',
             'workspaces.logo_file_id as ws_logo', 'organizations.logo_file_id as org_logo',
             eb.selectFrom('actors as m').select(sql<number>`count(*)::int`.as('n'))
               .whereRef('m.workspace_id', '=', 'workspaces.id')
               .where('m.type', '=', 'human').where('m.state', '=', 'active')
               .as('member_count')])
    .where('organizations.workos_org_id', 'in', workosOrgIds)
    .orderBy('workspaces.created_at')
    .execute();

  const invited = await invitedTo(db, id.workosUserId);
  const inOrg = new Set(rows.filter(r => r.actor_id).map(r => r.org_id));
  const mine = domainOf(id.email);
  const verified = await verifiedDomains(db, [...new Set(rows.map(r => r.org_id))]);

  const joins: PendingJoin[] = [];
  for (const r of rows) {
    if (r.actor_id) continue;   // already a member here
    const ws = { id: r.workspace_id, join_policy: r.join_policy };
    const offered = invited.has(r.workspace_id)
      || (r.join_policy === 'org_open' && !inOrg.has(r.org_id));
    if (!offered || !admissible(ws, invited)) continue;
    joins.push({
      orgId: r.org_id, workspaceId: r.workspace_id, name: r.name,
      handleSuggestions: (await suggestHandles(db, r.workspace_id, id)).slice(0, 5),
      reason: invited.has(r.workspace_id) ? 'invited'
        : mine && verified.get(r.org_id)?.has(mine) ? 'company' : 'member',
      logoUrl: r.ws_logo ?? r.org_logo ? `/files/${r.ws_logo ?? r.org_logo}` : null,
      isDefault: r.workspace_id === r.default_workspace_id,
      orgName: r.org_name, memberCount: r.member_count ?? 0,
      inviteOnly: r.join_policy === 'invite_only',
    });
  }
  // The default first within each org: it is where colleagues land.
  return joins.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

export interface Joined {
  actorId: string;
  orgId: string;
  workspaceId: string;
}

/**
 * Materialise the actor, with the handle they chose.
 *
 * Two ways in, and both are re-checked here rather than trusting the client's
 * word for it — `workspace_id` arrives in a request body, and a request body is
 * not evidence of anything:
 *
 *   member   WorkOS lists them in the org, and the workspace is open to the org
 *            or they were invited to it (`admissible`)
 *   domain   not yet in the org, but their VERIFIED mailbox is on a domain the
 *            org approved, and this is its default workspace (ORG-DOMAINS.md
 *            §4.1). They are added to the WorkOS org first.
 */
export async function joinWorkspace(
  db: Kysely<DB>, id: Identity, workspaceId: string, handle: string,
): Promise<Joined | 'not_invited' | 'handle_taken'> {
  const target = await db.selectFrom('workspaces')
    .innerJoin('organizations', 'organizations.id', 'workspaces.org_id')
    .select(['workspaces.id as workspace_id', 'workspaces.org_id as org_id',
             'workspaces.join_policy', 'organizations.default_workspace_id',
             'organizations.workos_org_id as workos_org_id'])
    .where('workspaces.id', '=', workspaceId)
    .executeTakeFirst();
  if (!target) return 'not_invited';

  // No initialiser: the try assigns it and the catch returns, so a `false` here
  // would be a value nothing ever reads.
  let member: boolean;
  try {
    const res = await listMemberships(id.workosUserId);
    member = res.data.some(m => m.organization_id === target.workos_org_id);
  } catch {
    // Unreachable is not the same as unauthorised, but it cannot be treated as
    // permission either — the person retries.
    return 'not_invited';
  }

  let via: 'invite' | 'domain';
  if (member) {
    let invited = await invitedTo(db, id.workosUserId);
    if (!admissible({ id: workspaceId, join_policy: target.join_policy }, invited)) {
      // Perhaps accepted since we last asked.
      await learnAcceptedInvitations(db, id.workosUserId, [target.workos_org_id]);
      invited = await invitedTo(db, id.workosUserId);
      if (!admissible({ id: workspaceId, join_policy: target.join_policy }, invited)) return 'not_invited';
    }
    via = 'invite';
  } else {
    // Any workspace open to the org — the join screen offers them all (§5).
    if (target.join_policy !== 'org_open') return 'not_invited';
    if (!await domainAdmits(db, target.org_id, id.email, id.emailVerified === true)) return 'not_invited';
    via = 'domain';
  }

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

  if (via === 'domain') {
    // WorkOS first, as for creating an org (provision.ts): a failure here
    // aborts before anything of ours exists. Then the mirror, ourselves, so
    // the new member is visible at once rather than one poll later.
    await addMember(target.workos_org_id, id.workosUserId);
    await recordWorkosMembership(db, id.workosUserId, target.workos_org_id);
  }

  const actorId = ulid('act');
  await db.transaction().execute(async (tx) => {
    await tx.insertInto('actors').values({
      id: actorId, org_id: target.org_id, workspace_id: workspaceId,
      type: 'human', handle, display_name: id.displayName, avatar_url: id.avatarUrl,
      identity_kind: 'workos_user', identity_id: id.workosUserId,
      owner_actor_id: null, provisioned_by: via, state: 'active',
    }).execute();

    // Every existing member of this workspace learns about the new arrival from
    // this one event — one row on each client, rather than a re-send of the
    // whole directory. That difference is the entire reason the directory is a
    // stream (docs/SYNC-FLOWS.md §9.1).
    await recordActor(tx, 'actor.created', {
      id: actorId, workspaceId, type: 'human', handle,
      displayName: id.displayName, avatarUrl: id.avatarUrl, ownerActorId: null, state: 'active',
    });

    // A member, not an admin. Being invited grants belonging, never authority
    // (AUTHZ.md §6) — a new joiner who could immediately invite would make the
    // admin gate on invite meaningless.
    await tx.insertInto('memberships').values({
      scope_type: 'workspace', scope_id: workspaceId,
      actor_id: actorId, role: 'member', left_at: null,
    }).execute();
  });

  count('identity.provisioned', { via });
  emit('identity.provisioned', {
    actor: actorId, org: target.org_id, workspace: workspaceId, via,
  });
  return { actorId, orgId: target.org_id, workspaceId };
}
