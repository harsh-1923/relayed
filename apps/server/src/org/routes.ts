// The organization above workspaces (docs/ORG-DOMAINS.md): browsing an org's
// workspaces, its approved domains, and the settings only its admins may change.
//
// Every route authenticates as the CALLER'S IDENTITY rather than their actor.
// An org spans workspaces and one person has an actor in each, so the question
// is always "is this person in, or an admin of, that org" — asked of the org in
// the URL, never of the org in the access token, which a claim can leave stale
// (§11.7).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from '../db/client.ts';
import { caller } from '../auth/caller.ts';
import { fetchProfile } from '../auth/workos-profile.ts';
import { canOrg, adminsWorkspace } from '../authz/org.ts';
import { isOrgMember } from '../workos/mirror.ts';
import { resolveMemberships, suggestHandles, type Identity } from '../provisioning/provision.ts';
import { pendingJoins } from '../provisioning/join.ts';
import { approvalRefusal, normaliseDomain, orgMatches, syncWorkosDomains, syncWorkosDomainsFor } from '../provisioning/domains.ts';

/** The signed-in person, or a reply already sent. Agents have no identity to act as. */
async function identityOf(authorization: string | undefined, reply: FastifyReply) {
  const me = await caller(authorization);
  if (!me) { reply.code(401).send({ error: 'unauthenticated' }); return null; }
  if (!me.workosUserId) { reply.code(403).send({ error: 'not_a_human_actor' }); return null; }
  return { ...me, workosUserId: me.workosUserId };
}

/**
 * In the org: WorkOS says so, or they hold an active actor in one of its
 * workspaces. The second is a backstop for the mirror, not a second authority —
 * every actor was admitted through WorkOS to get there.
 */
async function belongs(workosUserId: string, orgId: string): Promise<boolean> {
  if (await isOrgMember(db, workosUserId, orgId)) return true;
  return !!await db.selectFrom('actors').select('id')
    .where('org_id', '=', orgId).where('identity_kind', '=', 'workos_user')
    .where('identity_id', '=', workosUserId).where('state', '=', 'active')
    .executeTakeFirst();
}

async function domainsOf(orgId: string) {
  const rows = await db.selectFrom('organization_domains')
    .select(['domain', 'approved_at', 'verified_at', 'source'])
    .where('org_id', '=', orgId).orderBy('domain').execute();
  return rows.map(r => ({
    domain: r.domain, approved_at: r.approved_at, verified: r.verified_at !== null, source: r.source,
  }));
}

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What this person could join and has not — for the workspace switcher.
   *
   * The signed-in counterpart of /auth/session's `org_matches` and
   * `pending_joins`: someone who signed up before their company approved its
   * domain, or who accepted an invitation while signed in, finds it here. Live
   * on purpose — it runs when the switcher opens, not on every refresh — and it
   * is the one place a signed-in person's email is read (§10).
   */
  app.get('/org/matches', async (req, reply) => {
    const me = await identityOf(req.headers.authorization, reply);
    if (!me) return;
    const profile = await fetchProfile(me.workosUserId).catch(() => null);
    const actor = await db.selectFrom('actors').select(['display_name', 'avatar_url'])
      .where('id', '=', me.actorId).executeTakeFirstOrThrow();
    const identity: Identity = {
      workosUserId: me.workosUserId, email: profile?.email ?? '',
      emailVerified: profile?.emailVerified ?? false,
      displayName: actor.display_name, avatarUrl: actor.avatar_url,
    };
    const memberships = await resolveMemberships(db, me.workosUserId);
    const joins = await pendingJoins(db, identity, 'live');
    const exclude = new Set([...memberships.map(m => m.orgId), ...joins.map(j => j.orgId)]);
    if (identity.emailVerified) await syncWorkosDomainsFor(db, identity.email);
    const matches = await orgMatches(db, identity.email, identity.emailVerified === true, exclude);
    return reply.send({
      pending_joins: joins.map(j => ({
        org_id: j.orgId, workspace_id: j.workspaceId, name: j.name, handle_suggestions: j.handleSuggestions,
        reason: j.reason, logo_url: j.logoUrl, is_default: j.isDefault,
        org_name: j.orgName, member_count: j.memberCount, invite_only: j.inviteOnly,
      })),
      org_matches: await Promise.all(matches.map(async m => ({
        org_id: m.orgId, name: m.name, member_count: m.memberCount,
        workspace_id: m.workspaceId, workspace_name: m.workspaceName, logo_url: m.logoUrl, is_default: m.isDefault, workspace_member_count: m.workspaceMemberCount,
        handle_suggestions: (await suggestHandles(db, m.workspaceId, identity)).slice(0, 5),
      }))),
    });
  });

  /**
   * An org's workspaces, for *Browse workspaces* and for org settings.
   *
   * A member sees what they may enter — open workspaces — and what they are
   * already in. An org admin sees every workspace, invite-only included,
   * because choosing policies and the default is theirs; seeing a NAME is not
   * reading anything inside (§6.1).
   */
  app.get<{ Params: { id: string } }>('/org/:id/workspaces', async (req, reply) => {
    const me = await identityOf(req.headers.authorization, reply);
    if (!me) return;
    const orgId = req.params.id;
    if (!await belongs(me.workosUserId, orgId)) return reply.code(403).send({ error: 'not_an_org_member' });

    const isAdmin = await canOrg(db, me.workosUserId, 'manage_workspaces', orgId);
    const org = await db.selectFrom('organizations').select(['id', 'name', 'default_workspace_id'])
      .where('id', '=', orgId).executeTakeFirstOrThrow();
    const rows = await db.selectFrom('workspaces')
      .leftJoin('actors as mine', (join) => join
        .onRef('mine.workspace_id', '=', 'workspaces.id')
        .on('mine.identity_kind', '=', 'workos_user')
        .on('mine.identity_id', '=', me.workosUserId)
        .on('mine.state', '=', 'active'))
      .select((eb) => [
        'workspaces.id', 'workspaces.name', 'workspaces.slug', 'workspaces.join_policy',
        'mine.id as my_actor_id',
        eb.selectFrom('actors').select(eb.fn.countAll<number>().as('n'))
          .whereRef('actors.workspace_id', '=', 'workspaces.id')
          .where('actors.type', '=', 'human').where('actors.state', '=', 'active')
          .as('member_count'),
      ])
      .where('workspaces.org_id', '=', orgId)
      .orderBy('workspaces.created_at')
      .execute();

    const visible = rows.filter(r => isAdmin || r.join_policy === 'org_open' || r.my_actor_id);
    return reply.send({
      org: { id: org.id, name: org.name, is_admin: isAdmin },
      workspaces: visible.map(r => ({
        workspace_id: r.id, name: r.name, slug: r.slug, join_policy: r.join_policy,
        is_default: r.id === org.default_workspace_id, member_count: Number(r.member_count ?? 0),
        joined: !!r.my_actor_id,
      })),
    });
  });

  /** The org's approved domains. Any member may read them — they are shown on sign-in anyway. */
  app.get<{ Params: { id: string } }>('/org/:id/domains', async (req, reply) => {
    const me = await identityOf(req.headers.authorization, reply);
    if (!me) return;
    if (!await belongs(me.workosUserId, req.params.id)) return reply.code(403).send({ error: 'not_an_org_member' });
    // Live from WorkOS first: a domain just verified there, or just removed,
    // shows as soon as someone looks (§11).
    const org = await db.selectFrom('organizations').select('workos_org_id')
      .where('id', '=', req.params.id).executeTakeFirst();
    if (org) await syncWorkosDomains(db, [org.workos_org_id]);
    return reply.send({ domains: await domainsOf(req.params.id) });
  });

  /**
   * Approve a domain: anyone with a verified mailbox on it may join this org's
   * default workspace without an invitation (§4). Only the admin's OWN domain,
   * never a public one (§4.2, §4.3). Never exclusive — other orgs may approve
   * it too — unless another org has VERIFIED it (§11.2).
   */
  app.post<{ Params: { id: string }; Body: { domain?: string } }>('/org/:id/domains', async (req, reply) => {
    const me = await identityOf(req.headers.authorization, reply);
    if (!me) return;
    const orgId = req.params.id;
    if (!await canOrg(db, me.workosUserId, 'manage_domains', orgId)) {
      return reply.code(403).send({ error: 'forbidden', action: 'manage_domains' });
    }
    let profile;
    try { profile = await fetchProfile(me.workosUserId); }
    catch (e) { return reply.code(502).send({ error: 'profile_unavailable', detail: (e as Error).message }); }

    const refusal = approvalRefusal(profile.email, profile.emailVerified, req.body?.domain ?? '');
    if (refusal) return reply.code(400).send({ error: refusal });
    const domain = normaliseDomain(req.body!.domain!)!;

    const verifiedElsewhere = await db.selectFrom('organization_domains').select('org_id')
      .where('domain', '=', domain).where('verified_at', 'is not', null)
      .where('org_id', '<>', orgId).executeTakeFirst();
    if (verifiedElsewhere) return reply.code(409).send({ error: 'domain_verified_elsewhere' });

    await db.insertInto('organization_domains')
      .values({ org_id: orgId, domain, approved_by: me.workosUserId })
      .onConflict((oc) => oc.columns(['org_id', 'domain']).doNothing()).execute();
    return reply.send({ domains: await domainsOf(orgId) });
  });

  app.delete<{ Params: { id: string; domain: string } }>('/org/:id/domains/:domain', async (req, reply) => {
    const me = await identityOf(req.headers.authorization, reply);
    if (!me) return;
    if (!await canOrg(db, me.workosUserId, 'manage_domains', req.params.id)) {
      return reply.code(403).send({ error: 'forbidden', action: 'manage_domains' });
    }
    // A domain verified in WorkOS is WorkOS's to remove: deleting our copy
    // would change nothing but what the page says (§11).
    const managed = await db.selectFrom('organization_domains').select('source')
      .where('org_id', '=', req.params.id)
      .where('domain', '=', normaliseDomain(req.params.domain) ?? req.params.domain).executeTakeFirst();
    if (managed?.source === 'workos') return reply.code(409).send({ error: 'managed_in_workos' });
    // Stops new domain joins only. Everyone who joined through it stays: they
    // are org members now, exactly as if they had been invited.
    await db.deleteFrom('organization_domains')
      .where('org_id', '=', req.params.id)
      .where('domain', '=', normaliseDomain(req.params.domain) ?? req.params.domain).execute();
    return reply.send({ domains: await domainsOf(req.params.id) });
  });

  /**
   * An org admin's settings for one workspace: who may join it, and which
   * workspace is the default.
   *
   * The default is where a domain join lands and whose admins govern the org
   * (§6), so it must stay open, and moving it is allowed only to someone who
   * administers the new default — otherwise it would hand the org away, or lock
   * its last admin out (§16 q3).
   */
  app.patch<{ Params: { id: string }; Body: { join_policy?: string; make_default?: boolean } }>(
    '/workspaces/:id', async (req, reply) => {
      const me = await identityOf(req.headers.authorization, reply);
      if (!me) return;
      const ws = await db.selectFrom('workspaces')
        .innerJoin('organizations', 'organizations.id', 'workspaces.org_id')
        .select(['workspaces.id', 'workspaces.org_id', 'workspaces.join_policy',
                 'organizations.default_workspace_id'])
        .where('workspaces.id', '=', req.params.id).executeTakeFirst();
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      if (!await canOrg(db, me.workosUserId, 'manage_workspaces', ws.org_id)) {
        return reply.code(403).send({ error: 'forbidden', action: 'manage_workspaces' });
      }

      const { join_policy, make_default } = req.body ?? {};
      if (join_policy !== undefined && join_policy !== 'org_open' && join_policy !== 'invite_only') {
        return reply.code(400).send({ error: 'invalid_join_policy' });
      }
      const becomesDefault = make_default === true && ws.default_workspace_id !== ws.id;
      const isDefault = ws.default_workspace_id === ws.id || becomesDefault;
      if (isDefault && join_policy === 'invite_only') {
        return reply.code(409).send({ error: 'default_must_be_open' });
      }
      if (becomesDefault && !await adminsWorkspace(db, me.workosUserId, ws.id)) {
        return reply.code(403).send({ error: 'not_admin_of_new_default' });
      }

      await db.transaction().execute(async (tx) => {
        const policy = becomesDefault ? 'org_open' : join_policy;
        if (policy) await tx.updateTable('workspaces').set({ join_policy: policy }).where('id', '=', ws.id).execute();
        if (becomesDefault) {
          await tx.updateTable('organizations').set({ default_workspace_id: ws.id })
            .where('id', '=', ws.org_id).execute();
        }
      });
      return reply.send({ ok: true });
    });
}
