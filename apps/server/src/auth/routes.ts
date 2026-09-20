// Session exchange. The client trades a WorkOS token for OURS, then never
// talks to WorkOS again until the next interactive sign-in — which is what
// keeps steady-state sync independent of WorkOS availability.
import type { FastifyInstance } from 'fastify';
import { histogram } from '@relayed/telemetry';
import { db } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { env } from '../env.ts';
import { verifyWorkOSToken } from './workos-verify.ts';
import { fetchProfile } from './workos-profile.ts';
import { signAccessToken, newRefreshToken, hashRefreshToken, verifyAccessToken } from './tokens.ts';
import {
  resolveMemberships, selectMembership, createWorkspace, suggestHandles,
  type Identity, type Membership,
} from '../provisioning/provision.ts';
import { validateHandle } from '../provisioning/handle.ts';
import { pendingJoins, joinWorkspace } from '../provisioning/join.ts';
import { seedWorkspace, joinPublicSpaces } from '../provisioning/onboard.ts';

interface ExchangeBody {
  workos_access_token: string;
  device_id: string;
  /**
   * The workspace the client had open (STORAGE.md §10.1). Omitted by a fresh
   * install, which gets the oldest membership.
   */
  workspace_id?: string;
}

/**
 * Wire shape of a membership. snake_case, like every other field we return.
 *
 * Every avatar field says whose it is: the workspace has one, and so does the
 * member. An unqualified name here is what let the member's face be painted on
 * every workspace icon.
 */
const wire = (m: Membership) => ({
  workspace_id: m.workspaceId, org_id: m.orgId, name: m.name, slug: m.slug,
  workspace_avatar_url: m.workspaceAvatarUrl,
  actor_id: m.actorId, actor_handle: m.actorHandle,
  actor_display_name: m.actorDisplayName, actor_avatar_url: m.actorAvatarUrl,
  actor_role: m.actorRole,
});

async function issue(actorId: string, orgId: string, workspaceId: string, deviceId: string) {
  const sessionId = ulid('ses');
  const refresh = newRefreshToken();
  const expires = new Date(Date.now() + env.refreshTokenTtlSec * 1000);

  await db.insertInto('sessions').values({
    id: sessionId, actor_id: actorId, device_id: deviceId,
    refresh_hash: hashRefreshToken(refresh), expires_at: expires,
    revoked_at: null,
  }).execute();

  return {
    access_token: await signAccessToken({ actorId, orgId, workspaceId, deviceId, sessionId }),
    refresh_token: refresh,
    expires_in: env.accessTokenTtlSec,
  };
}

async function identityFrom(workosAccessToken: string): Promise<Identity> {
  const claims = await verifyWorkOSToken(workosAccessToken);
  const profile = await fetchProfile(claims.userId);
  return { workosUserId: claims.userId, ...profile };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Trade a WorkOS access token for one of ours. */
  app.post<{ Body: ExchangeBody }>('/auth/session', async (req, reply) => {
    const { workos_access_token, device_id, workspace_id } = req.body ?? {};
    if (!workos_access_token || !device_id) {
      return reply.code(400).send({ error: 'workos_access_token and device_id are required' });
    }

    let identity: Identity;
    try { identity = await identityFrom(workos_access_token); }
    catch (e) {
      const msg = (e as Error).message;
      return /profile/i.test(msg)
        ? reply.code(502).send({ error: 'profile_unavailable', detail: msg })
        : reply.code(401).send({ error: 'invalid_token', detail: msg });
    }

    const memberships = await resolveMemberships(db, identity.workosUserId);
    // Workspaces per identity — the distribution multi-workspace was built for.
    // Sampled here because every sign-in passes through, and unrecoverable
    // later: logs holding it are gone in 14 days (OBSERVABILITY.md §5).
    histogram('identity.memberships', memberships.length);
    const chosen = selectMembership(memberships, workspace_id);

    if (chosen === null) {
      // No actor anywhere for this identity. Either a genuine first sign-up, or
      // someone who accepted an invitation and has no workspace of their own —
      // and those are different screens, so both are answered here. Pushing an
      // invited person into creating a workspace reads as a broken invite.
      const joins = await pendingJoins(db, identity);
      return reply.send({
        needs_workspace: true,
        handle_suggestions: (await suggestHandles(db, '', identity)).slice(0, 5),
        identity: { email: identity.email, displayName: identity.displayName },
        pending_joins: joins.map(j => ({
          org_id: j.orgId, workspace_id: j.workspaceId, name: j.name,
          handle_suggestions: j.handleSuggestions,
        })),
      });
    }
    if (chosen === 'not_a_member') {
      return reply.code(403).send({ error: 'not_a_member', detail: 'no actor in that workspace' });
    }

    return reply.send({
      needs_workspace: false,
      // Workspaces WorkOS says they belong to and we have no actor for — an
      // accepted invitation, seen for the first time. Not auto-joined: a handle
      // is required and this is where one can already be taken (AUTHZ.md §9).
      pending_joins: (await pendingJoins(db, identity)).map(j => ({
        org_id: j.orgId, workspace_id: j.workspaceId, name: j.name,
        handle_suggestions: j.handleSuggestions,
      })),
      actor: { actorId: chosen.actorId, orgId: chosen.orgId, workspaceId: chosen.workspaceId },
      // ALL of them, so the client can populate account.db and draw the
      // switcher without a second call (STORAGE.md §6).
      memberships: memberships.map(wire),
      ...(await issue(chosen.actorId, chosen.orgId, chosen.workspaceId, device_id)),
    });
  });

  /**
   * Onboarding, and the ordinary path to an additional workspace.
   *
   * There is deliberately no `already_provisioned` guard: an identity holding
   * one workspace creating another is the same operation, and before
   * invitations exist it is the only way to reach a multi-workspace account at
   * all (STORAGE.md §10.4).
   */
  app.post<{ Body: Partial<ExchangeBody> & { workspace_name: string; handle: string } }>(
    '/auth/workspace', async (req, reply) => {
      const { workos_access_token, device_id, workspace_name, handle } = req.body ?? {};
      if (!workspace_name || !handle) {
        return reply.code(400).send({ error: 'missing required fields' });
      }
      const bad = validateHandle(handle);
      if (bad) return reply.code(400).send({ error: 'invalid_handle', reason: bad });

      // Two ways to prove identity here, because there are two callers.
      //
      // Onboarding holds a WorkOS token and no session yet. A signed-in user
      // creating an ADDITIONAL workspace holds one of our tokens — and sending
      // them back through the browser for a token they already effectively have
      // would be an absurd way to click "new workspace".
      let identity: Identity;
      let deviceId = device_id;
      const bearer = (req.headers.authorization ?? '').startsWith('Bearer ')
        ? (req.headers.authorization ?? '').slice(7)
        : '';

      if (workos_access_token) {
        try { identity = await identityFrom(workos_access_token); }
        catch (e) {
          const msg = (e as Error).message;
          return /profile/i.test(msg)
            ? reply.code(502).send({ error: 'profile_unavailable', detail: msg })
            : reply.code(401).send({ error: 'invalid_token', detail: msg });
        }
      } else if (bearer) {
        let claims;
        try { claims = await verifyAccessToken(bearer); }
        catch (e) { return reply.code(401).send({ error: 'invalid_token', detail: (e as Error).message }); }

        const actor = await db.selectFrom('actors')
          .select(['identity_kind', 'identity_id', 'display_name', 'avatar_url'])
          .where('id', '=', claims.actorId).executeTakeFirst();
        if (!actor?.identity_id || actor.identity_kind !== 'workos_user') {
          return reply.code(403).send({ error: 'not_a_human_actor' });
        }
        // Email is absent by design (§6.2 — never a join key) and is only ever
        // used to seed handle suggestions, which this caller does not need:
        // they are typing a handle for the new workspace.
        identity = {
          workosUserId: actor.identity_id, email: '',
          displayName: actor.display_name, avatarUrl: actor.avatar_url,
        };
        deviceId ??= claims.deviceId;
      } else {
        return reply.code(401).send({ error: 'no_credential' });
      }

      if (!deviceId) return reply.code(400).send({ error: 'device_id required' });

      const created = await createWorkspace(db, identity, { workspaceName: workspace_name, handle });
      // A workspace with nowhere to talk is not a workspace. Fire-and-forget
      // relative to the response: a channel that failed to appear is repaired
      // by the next sign-in, and is not a reason to fail a sign-up that has
      // already created an organisation at WorkOS.
      try { await seedWorkspace(db, created.workspaceId, created.actorId); }
      catch (e) { req.log.warn({ err: e }, 'default channel not created'); }
      const memberships = await resolveMemberships(db, identity.workosUserId);
      return reply.send({
        needs_workspace: false,
        actor: created,
        memberships: memberships.map(wire),
        ...(await issue(created.actorId, created.orgId, created.workspaceId, deviceId)),
      });
    });

  /**
   * A session for a DIFFERENT workspace of the same identity.
   *
   * Takes the refresh token rather than the access token: by switch time the
   * access token has usually expired, and requiring a fresh one would make this
   * two round trips for no gain.
   *
   * Called ONCE per workspace, ever — the first time it is opened on this
   * device. Afterwards that workspace has its own refresh token on disk and
   * uses /auth/refresh like any other (STORAGE.md §9).
   */
  app.post<{ Body: { refresh_token: string; workspace_id: string } }>(
    '/auth/switch', async (req, reply) => {
      const { refresh_token, workspace_id } = req.body ?? {};
      if (!refresh_token || !workspace_id) {
        return reply.code(400).send({ error: 'refresh_token and workspace_id are required' });
      }

      const source = await db.selectFrom('sessions')
        .innerJoin('actors', 'actors.id', 'sessions.actor_id')
        .select(['sessions.device_id', 'sessions.expires_at', 'sessions.revoked_at',
                 'actors.identity_kind', 'actors.identity_id', 'actors.state'])
        .where('sessions.refresh_hash', '=', hashRefreshToken(refresh_token))
        .executeTakeFirst();

      if (!source || source.revoked_at || new Date(source.expires_at) < new Date()) {
        return reply.code(401).send({ error: 'invalid_refresh_token' });
      }
      if (source.state !== 'active') return reply.code(403).send({ error: 'actor_' + source.state });
      if (!source.identity_id) return reply.code(403).send({ error: 'no_identity' });

      const target = await db.selectFrom('actors')
        .select(['id', 'org_id', 'workspace_id'])
        .where('workspace_id', '=', workspace_id)
        .where('identity_kind', '=', source.identity_kind)
        .where('identity_id', '=', source.identity_id)
        .where('state', '=', 'active')
        .executeTakeFirst();

      if (!target) return reply.code(403).send({ error: 'not_a_member' });

      // The source session is deliberately NOT revoked and NOT rotated
      // (invariant 44). The workspace being switched away from must stay
      // drainable and returnable-to without a network round trip.
      //
      // device_id comes from the session, not the request body: the credential
      // is what says which install this is.
      return reply.send({
        needs_workspace: false,
        actor: { actorId: target.id, orgId: target.org_id, workspaceId: target.workspace_id },
        ...(await issue(target.id, target.org_id, target.workspace_id, source.device_id)),
      });
    });

  /**
   * Accept a workspace one has been admitted to in WorkOS, with a chosen handle.
   *
   * Not an "accept invitation" endpoint: WorkOS already accepted it on its
   * hosted page before the app was ever opened (join.ts). This is the moment the
   * actor comes into existence, which is separate because it needs a handle.
   */
  app.post<{ Body: Partial<ExchangeBody> & { workspace_id: string; handle: string } }>(
    '/auth/join', async (req, reply) => {
      const { workos_access_token, device_id, workspace_id, handle } = req.body ?? {};
      if (!workspace_id || !handle) {
        return reply.code(400).send({ error: 'missing required fields' });
      }
      const bad = validateHandle(handle);
      if (bad) return reply.code(400).send({ error: 'invalid_handle', reason: bad });

      // TWO WAYS TO PROVE IDENTITY, exactly as /auth/workspace above, and for
      // the same reason: there are two callers.
      //
      // Onboarding holds a WorkOS token and has no session. But somebody who
      // signed up first and was invited afterwards is already signed in to a
      // DIFFERENT workspace, holds one of our tokens, and has no WorkOS token
      // any more — it is dropped the moment onboarding completes. Requiring one
      // here meant that person could never accept an invitation: the only way
      // back to a WorkOS token is another trip through the browser, and nothing
      // asks for one once you are signed in.
      let identity: Identity;
      let deviceId = device_id;
      const bearer = (req.headers.authorization ?? '').startsWith('Bearer ')
        ? (req.headers.authorization ?? '').slice(7)
        : '';

      if (workos_access_token) {
        try { identity = await identityFrom(workos_access_token); }
        catch (e) {
          const msg = (e as Error).message;
          return /profile/i.test(msg)
            ? reply.code(502).send({ error: 'profile_unavailable', detail: msg })
            : reply.code(401).send({ error: 'invalid_token', detail: msg });
        }
      } else if (bearer) {
        let claims;
        try { claims = await verifyAccessToken(bearer); }
        catch (e) { return reply.code(401).send({ error: 'invalid_token', detail: (e as Error).message }); }

        const actor = await db.selectFrom('actors')
          .select(['identity_kind', 'identity_id', 'display_name', 'avatar_url'])
          .where('id', '=', claims.actorId).executeTakeFirst();
        if (!actor?.identity_id || actor.identity_kind !== 'workos_user') {
          return reply.code(403).send({ error: 'not_a_human_actor' });
        }
        // Email is absent by design (§6.2 — never a join key). `joinWorkspace`
        // authorises against the WorkOS MEMBERSHIP, not the address.
        identity = {
          workosUserId: actor.identity_id, email: '',
          displayName: actor.display_name, avatarUrl: actor.avatar_url,
        };
        deviceId ??= claims.deviceId;
      } else {
        return reply.code(401).send({ error: 'no_credential' });
      }

      if (!deviceId) return reply.code(400).send({ error: 'device_id required' });

      const joined = await joinWorkspace(db, identity, workspace_id, handle);
      if (typeof joined === 'object') {
        // Public means everyone in the workspace, and this is where that becomes
        // true rather than documented: `welcome` joins spaces on MEMBERSHIP, so
        // without these rows a joiner sees an empty workspace.
        try { await joinPublicSpaces(db, workspace_id, joined.actorId); }
        catch (e) { req.log.warn({ err: e }, 'public spaces not joined'); }
      }
      if (joined === 'not_invited') {
        return reply.code(403).send({ error: 'not_invited' });
      }
      if (joined === 'handle_taken') {
        // Never auto-suffixed (§10). They pick again.
        return reply.code(409).send({
          error: 'handle_taken',
          handle_suggestions: (await suggestHandles(db, workspace_id, identity)).slice(0, 5),
        });
      }

      const memberships = await resolveMemberships(db, identity.workosUserId);
      return reply.send({
        needs_workspace: false,
        actor: joined,
        memberships: memberships.map(wire),
        ...(await issue(joined.actorId, joined.orgId, joined.workspaceId, deviceId)),
      });
    });

  /** Rotate. The old refresh token is revoked in the same statement it is used. */
  app.post<{ Body: { refresh_token: string } }>('/auth/refresh', async (req, reply) => {
    const token = req.body?.refresh_token;
    if (!token) return reply.code(400).send({ error: 'refresh_token required' });

    const row = await db.selectFrom('sessions')
      .innerJoin('actors', 'actors.id', 'sessions.actor_id')
      .select(['sessions.id as sid', 'sessions.actor_id', 'sessions.device_id',
               'sessions.expires_at', 'sessions.revoked_at',
               'actors.org_id', 'actors.workspace_id', 'actors.state',
               'actors.identity_id', 'actors.display_name'])
      .where('sessions.refresh_hash', '=', hashRefreshToken(token))
      .executeTakeFirst();

    if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
      return reply.code(401).send({ error: 'invalid_refresh_token' });
    }
    // Deactivation is checked on every refresh: this is the backstop for a
    // WorkOS deactivation that our webhook has not yet processed.
    if (row.state === 'deactivated' || row.state === 'suspended') {
      return reply.code(403).send({ error: 'actor_' + row.state });
    }

    // Rotation: revoke the old row and issue a new one, so a stolen refresh
    // token stops working the moment the legitimate client refreshes.
    await db.updateTable('sessions').set({ revoked_at: new Date() })
      .where('id', '=', row.sid).execute();

    // Memberships ride along, so a workspace added server-side reaches the
    // client on its next boot without a separate poll (STORAGE.md §10.3).
    const memberships = row.identity_id
      ? await resolveMemberships(db, row.identity_id)
      : [];

    // And invitations accepted since the last sign-in. Read from the MIRROR
    // rather than from WorkOS: refresh happens every few minutes, and a
    // Management API call on each would be a per-user rate against a quota to
    // learn something the poller already knows.
    // The display name comes from the actor we already have. Email would give
    // better suggestions and is deliberately not stored (§6.2), so a name-based
    // suggestion is the best available — and an empty identity here produced no
    // suggestions at all, leaving the join screen asking people to invent one.
    const joins = row.identity_id
      ? await pendingJoins(db, {
          workosUserId: row.identity_id, email: '',
          displayName: row.display_name, avatarUrl: null,
        }, 'mirror')
      : [];

    return reply.send({
      // `actor` is returned here for the same reason every sibling endpoint
      // returns it: without it the client cannot tell which workspace the new
      // token is scoped to, and a client that cannot tell drops the
      // memberships travelling alongside it. That is exactly what happened —
      // memberships were sent on every refresh and applied on none of them,
      // so a workspace added server-side never reached the client.
      actor: { actorId: row.actor_id, orgId: row.org_id, workspaceId: row.workspace_id },
      memberships: memberships.map(wire),
      pending_joins: joins.map(j => ({
        org_id: j.orgId, workspace_id: j.workspaceId, name: j.name,
        handle_suggestions: j.handleSuggestions,
      })),
      ...(await issue(row.actor_id, row.org_id, row.workspace_id, row.device_id)),
    });
  });

  /** Sign out this device only. */
  app.post<{ Body: { refresh_token?: string } }>('/auth/signout', async (req, reply) => {
    const token = req.body?.refresh_token;
    if (token) {
      await db.updateTable('sessions').set({ revoked_at: new Date() })
        .where('refresh_hash', '=', hashRefreshToken(token)).execute();
    }
    return reply.send({ ok: true });
  });

  /** Who am I, per our own token. Used by the socket handshake later. */
  app.get('/auth/me', async (req, reply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return reply.code(401).send({ error: 'missing bearer token' });
    try {
      const claims = await verifyAccessToken(token);
      const actor = await db.selectFrom('actors')
        .select(['id', 'handle', 'display_name', 'avatar_url', 'org_id', 'workspace_id', 'state'])
        .where('id', '=', claims.actorId).executeTakeFirst();
      if (!actor) return reply.code(404).send({ error: 'actor_not_found' });
      return reply.send({ actor, device_id: claims.deviceId, session_id: claims.sessionId });
    } catch (e) {
      return reply.code(401).send({ error: 'invalid_token', detail: (e as Error).message });
    }
  });
}
