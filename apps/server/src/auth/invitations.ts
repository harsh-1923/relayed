// Invitations (PHASE-1-IDENTITY.md §9 decision 2, AUTHZ.md §9).
//
// The first feature that has to answer "is this person allowed to", and it asks
// exactly one question through exactly one function. No route below tests a
// role: `can()` is the only place that knows what `admin` means, which is what
// keeps swapping the evaluator a one-file change (AUTHZ.md §7).
//
// Email appears here and nowhere else in the system. §6.2 forbids keying
// anything on it; an invitation is inherently addressed to one, so it is passed
// to WorkOS and never written down.
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.ts';
import { caller, type Caller } from './caller.ts';
import { canDb, Forbidden } from '../authz/can.ts';
import { workspace } from '@relayed/authz';
import {
  createInvitation, listInvitations, revokeInvitation, WorkOSError,
} from '../workos/management.ts';

/** The WorkOS organization an invitation is addressed to. */
async function workosOrgFor(workspaceId: string): Promise<string | null> {
  const row = await db.selectFrom('workspaces')
    .innerJoin('organizations', 'organizations.id', 'workspaces.org_id')
    .select('organizations.workos_org_id as id')
    .where('workspaces.id', '=', workspaceId).executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Keep only the invitations sent from THIS workspace.
 *
 * WorkOS lists invitations per org, and an org now holds several workspaces —
 * an admin of one must not see, or revoke, another's. An invitation with no
 * `workspace_invitations` row predates them; its org held one workspace, now
 * its default, so it belongs there.
 */
async function ofWorkspace<T extends { id: string }>(workspaceId: string, list: T[]): Promise<T[]> {
  if (list.length === 0) return list;
  const rows = await db.selectFrom('workspace_invitations')
    .select(['workos_invitation_id', 'workspace_id'])
    .where('workos_invitation_id', 'in', list.map(i => i.id)).execute();
  const from = new Map(rows.map(r => [r.workos_invitation_id, r.workspace_id]));
  const isDefault = !!await db.selectFrom('organizations').select('id')
    .where('default_workspace_id', '=', workspaceId).executeTakeFirst();
  return list.filter(i => from.has(i.id) ? from.get(i.id) === workspaceId : isDefault);
}

const wire = (i: { id: string; email: string; state: string; expires_at: string }) => ({
  id: i.id, email: i.email, state: i.state, expires_at: i.expires_at,
});

export async function invitationRoutes(app: FastifyInstance): Promise<void> {
  /** Invite someone to the workspace this session is scoped to. */
  app.post<{ Body: { email: string } }>('/invitations', async (req, reply) => {
    const me = await caller(req.headers.authorization);
    if (!me) return reply.code(401).send({ error: 'unauthenticated' });

    const email = (req.body?.email ?? '').trim();
    // Shape only. WorkOS does the real validation and owns deliverability; we
    // are checking that a field was filled in, not adjudicating addresses.
    if (!email || !email.includes('@')) {
      return reply.code(400).send({ error: 'invalid_email' });
    }

    try {
      await requireCan(me, 'invite');
    } catch (e) {
      if (e instanceof Forbidden) return reply.code(403).send({ error: 'forbidden', action: 'invite' });
      throw e;
    }

    const orgId = await workosOrgFor(me.workspaceId);
    if (!orgId) {
      // A workspace whose organization was never created cannot be invited to.
      // Explicit, because the alternative is a 500 that looks like our bug.
      return reply.code(409).send({ error: 'organization_not_provisioned' });
    }

    try {
      const inv = await createInvitation(orgId, email, me.workosUserId ?? undefined);
      // WorkOS addresses the invitation to the ORG. This row is the only record
      // of which workspace it came from — without it, accepting would admit to
      // none of an org's invite-only workspaces, or to all of them
      // (ORG-DOMAINS.md §5.2). Upsert: WorkOS may return an existing pending
      // invitation for the same address.
      await db.insertInto('workspace_invitations').values({
        workos_invitation_id: inv.id, workspace_id: me.workspaceId, invited_by_actor_id: me.actorId,
      }).onConflict((oc) => oc.column('workos_invitation_id').doUpdateSet({
        workspace_id: me.workspaceId, invited_by_actor_id: me.actorId,
      })).execute();
      return reply.send({ invitation: wire(inv) });
    } catch (e) {
      const err = e as WorkOSError;
      return reply.code(err.status >= 400 && err.status < 500 ? 400 : 502)
        .send({ error: 'invitation_failed', code: err.code, detail: err.message });
    }
  });

  app.get('/invitations', async (req, reply) => {
    const me = await caller(req.headers.authorization);
    if (!me) return reply.code(401).send({ error: 'unauthenticated' });
    // Seeing who has been invited is part of managing members, not of belonging.
    try { await requireCan(me, 'manage_members'); }
    catch (e) {
      if (e instanceof Forbidden) return reply.code(403).send({ error: 'forbidden' });
      throw e;
    }

    const orgId = await workosOrgFor(me.workspaceId);
    if (!orgId) return reply.send({ invitations: [] });
    try {
      const list = await listInvitations(orgId);
      const mine = await ofWorkspace(me.workspaceId, list.data.filter(i => i.state === 'pending'));
      return reply.send({ invitations: mine.map(wire) });
    } catch (e) {
      return reply.code(502).send({ error: 'workos_unavailable', detail: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/invitations/:id/revoke', async (req, reply) => {
    const me = await caller(req.headers.authorization);
    if (!me) return reply.code(401).send({ error: 'unauthenticated' });
    try { await requireCan(me, 'manage_members'); }
    catch (e) {
      if (e instanceof Forbidden) return reply.code(403).send({ error: 'forbidden' });
      throw e;
    }

    const orgId = await workosOrgFor(me.workspaceId);
    if (!orgId) return reply.code(409).send({ error: 'organization_not_provisioned' });

    // Scoped, not trusted: an invitation id in a URL says nothing about which
    // workspace it belongs to, so it is only revocable if it is one of ours.
    try {
      const list = await listInvitations(orgId);
      if (!(await ofWorkspace(me.workspaceId, list.data)).some(i => i.id === req.params.id)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const revoked = await revokeInvitation(req.params.id);
      return reply.send({ invitation: wire(revoked) });
    } catch (e) {
      return reply.code(502).send({ error: 'workos_unavailable', detail: (e as Error).message });
    }
  });
}

async function requireCan(me: Caller, action: 'invite' | 'manage_members'): Promise<void> {
  if (!await canDb(db, me.actorId, action, workspace(me.workspaceId))) {
    throw new Forbidden(action, workspace(me.workspaceId));
  }
}
