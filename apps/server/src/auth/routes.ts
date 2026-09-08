// Session exchange. The client trades a WorkOS token for OURS, then never
// talks to WorkOS again until the next interactive sign-in — which is what
// keeps steady-state sync independent of WorkOS availability.
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { env } from '../env.ts';
import { verifyWorkOSToken } from './workos-verify.ts';
import { fetchProfile } from './workos-profile.ts';
import { signAccessToken, newRefreshToken, hashRefreshToken, verifyAccessToken } from './tokens.ts';
import { resolveActor, createWorkspace, suggestHandles, type Identity } from '../provisioning/provision.ts';
import { validateHandle } from '../provisioning/handle.ts';

interface ExchangeBody {
  workos_access_token: string;
  device_id: string;
}

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

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Trade a WorkOS access token for one of ours. */
  app.post<{ Body: ExchangeBody }>('/auth/session', async (req, reply) => {
    const { workos_access_token, device_id } = req.body ?? {};
    if (!workos_access_token || !device_id) {
      return reply.code(400).send({ error: 'workos_access_token and device_id are required' });
    }

    let claims;
    try { claims = await verifyWorkOSToken(workos_access_token); }
    catch (e) { return reply.code(401).send({ error: 'invalid_token', detail: (e as Error).message }); }

    let identity: Identity;
    try {
      const profile = await fetchProfile(claims.userId);
      identity = { workosUserId: claims.userId, ...profile };
    } catch (e) {
      return reply.code(502).send({ error: 'profile_unavailable', detail: (e as Error).message });
    }

    const existing = await resolveActor(db, identity);
    if (!existing) {
      // No org for this identity. Per §9 decision 1 we do NOT create one here —
      // the client runs onboarding and calls /auth/workspace with a chosen name
      // and handle. Invited users never reach this branch.
      return reply.send({
        needs_workspace: true,
        handle_suggestions: (await suggestHandles(db, '', identity)).slice(0, 5),
        identity: { email: identity.email, displayName: identity.displayName },
      });
    }

    return reply.send({
      needs_workspace: false,
      actor: existing,
      ...(await issue(existing.actorId, existing.orgId, existing.workspaceId, device_id)),
    });
  });

  /** Onboarding: create the org, workspace and founding actor. */
  app.post<{ Body: ExchangeBody & { workspace_name: string; handle: string } }>(
    '/auth/workspace', async (req, reply) => {
      const { workos_access_token, device_id, workspace_name, handle } = req.body ?? {};
      if (!workos_access_token || !device_id || !workspace_name || !handle) {
        return reply.code(400).send({ error: 'missing required fields' });
      }
      const bad = validateHandle(handle);
      if (bad) return reply.code(400).send({ error: 'invalid_handle', reason: bad });

      let claims;
      try { claims = await verifyWorkOSToken(workos_access_token); }
      catch { return reply.code(401).send({ error: 'invalid_token' }); }

      let identity: Identity;
      try {
        const profile = await fetchProfile(claims.userId);
        identity = { workosUserId: claims.userId, ...profile };
      } catch (e) {
        return reply.code(502).send({ error: 'profile_unavailable', detail: (e as Error).message });
      }

      if (await resolveActor(db, identity)) {
        return reply.code(409).send({ error: 'already_provisioned' });
      }

      const created = await createWorkspace(db, identity, { workspaceName: workspace_name, handle });
      return reply.send({
        needs_workspace: false, actor: created,
        ...(await issue(created.actorId, created.orgId, created.workspaceId, device_id)),
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
               'actors.org_id', 'actors.workspace_id', 'actors.state'])
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

    return reply.send(await issue(row.actor_id, row.org_id, row.workspace_id, row.device_id));
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
