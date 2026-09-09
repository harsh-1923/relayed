import type { Role } from '@relayed/authz';

// Client for OUR auth server. Everything after the initial WorkOS exchange goes
// through here, so steady-state sync depends only on our server being up
// (PHASE-1-IDENTITY.md §6).
export interface Actor {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  orgId: string;
  workspaceId: string;
}

export interface OurSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  actor: Actor | null;
  pendingJoins: PendingJoin[];
  /**
   * EVERY workspace this identity belongs to (STORAGE.md §10.1). Populated by
   * /auth/session, /auth/workspace and /auth/refresh; empty from /auth/switch,
   * which is scoped to one workspace and says nothing new about the others.
   */
  memberships: Membership[];
}

/**
 * One row of the switcher, cached in account.db (STORAGE.md §6).
 *
 * Two subjects, so every field says whose it is — see account migration v4.
 */
export interface Membership {
  workspaceId: string;
  orgId: string;
  name: string;
  slug: string;
  workspaceAvatarUrl: string | null;
  actorId: string;
  actorHandle: string;
  actorDisplayName: string;
  actorAvatarUrl: string | null;
  actorRole: Role;
}

/** A workspace we were admitted to in WorkOS and have no actor for yet (§9). */
export interface PendingJoin {
  workspaceId: string;
  orgId: string;
  name: string;
  handleSuggestions: string[];
}

/** Returned when the identity has no organization yet (§9 decision 1). */
export interface NeedsWorkspace {
  needsWorkspace: true;
  identity: { email: string; displayName: string };
  handleSuggestions: string[];
  /** An invited person has no org of their own — and must not be pushed into
   *  creating one, which reads as a broken invite. */
  pendingJoins: PendingJoin[];
}

export class ServerError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ServerError';
    this.code = code;
    this.status = status;
  }
}

const baseUrl = () => process.env['RELAYED_SERVER_URL'] ?? 'http://127.0.0.1:8787';

async function get<T>(path: string, bearer: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
  } catch (e) {
    throw new ServerError((e as Error).message, 'network', 0);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ServerError(String(json['detail'] ?? json['error'] ?? res.statusText),
                          String(json['error'] ?? `http_${res.status}`), res.status);
  }
  return json as T;
}

async function post<T>(path: string, body: unknown, bearer?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // Offline or the server is down. Distinguished from a rejection so the
    // session can go `stale` rather than `signed_out` — the difference between
    // "try again later" and "your credentials are gone".
    throw new ServerError((e as Error).message, 'network', 0);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ServerError(
      String(json['detail'] ?? json['error'] ?? res.statusText),
      String(json['error'] ?? `http_${res.status}`),
      res.status,
    );
  }
  return json as T;
}

interface RawSession {
  needs_workspace?: boolean;
  identity?: { email: string; displayName: string };
  handle_suggestions?: string[];
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  actor?: { actorId: string; orgId: string; workspaceId: string };
  memberships?: RawMembership[];
  pending_joins?: { workspace_id: string; org_id: string; name: string;
                    handle_suggestions: string[] }[];
}

interface RawMembership {
  workspace_id: string; org_id: string; name: string; slug: string;
  workspace_avatar_url: string | null;
  actor_id: string; actor_handle: string; actor_display_name: string;
  actor_avatar_url: string | null; actor_role: Role;
}

const toMembership = (m: RawMembership): Membership => ({
  workspaceId: m.workspace_id, orgId: m.org_id, name: m.name, slug: m.slug,
  workspaceAvatarUrl: m.workspace_avatar_url ?? null,
  actorId: m.actor_id, actorHandle: m.actor_handle,
  actorDisplayName: m.actor_display_name, actorAvatarUrl: m.actor_avatar_url ?? null,
  actorRole: m.actor_role ?? 'member',
});

const toSession = (raw: RawSession): OurSession => ({
  accessToken: raw.access_token ?? '',
  refreshToken: raw.refresh_token ?? '',
  expiresAt: Date.now() + (raw.expires_in ?? 900) * 1000,
  actor: raw.actor
    ? { id: raw.actor.actorId, handle: '', displayName: '', avatarUrl: null,
        orgId: raw.actor.orgId, workspaceId: raw.actor.workspaceId }
    : null,
  memberships: (raw.memberships ?? []).map(toMembership),
  pendingJoins: (raw.pending_joins ?? []).map(j => ({
    workspaceId: j.workspace_id, orgId: j.org_id, name: j.name,
    handleSuggestions: j.handle_suggestions ?? [],
  })),
});

/** Trade a verified WorkOS token for our session. */
export async function exchangeForSession(
  workosAccessToken: string, deviceId: string, preferredWorkspaceId?: string,
): Promise<OurSession | NeedsWorkspace> {
  const raw = await post<RawSession>('/auth/session', {
    workos_access_token: workosAccessToken, device_id: deviceId,
    // The workspace this install had open. Omitted on a fresh install, which
    // gets the oldest membership rather than an arbitrary one (§10.1).
    ...(preferredWorkspaceId ? { workspace_id: preferredWorkspaceId } : {}),
  });
  if (raw.needs_workspace) {
    return {
      needsWorkspace: true,
      identity: raw.identity ?? { email: '', displayName: '' },
      handleSuggestions: raw.handle_suggestions ?? [],
      pendingJoins: (raw.pending_joins ?? []).map(j => ({
        workspaceId: j.workspace_id, orgId: j.org_id, name: j.name,
        handleSuggestions: j.handle_suggestions ?? [],
      })),
    };
  }
  return toSession(raw);
}

/** Onboarding: create the org, workspace and founding actor. */
export const createWorkspace = async (
  workosAccessToken: string, deviceId: string, workspaceName: string, handle: string,
): Promise<OurSession> =>
  toSession(await post<RawSession>('/auth/workspace', {
    workos_access_token: workosAccessToken, device_id: deviceId,
    workspace_name: workspaceName, handle,
  }));

/**
 * An ADDITIONAL workspace, for someone already signed in.
 *
 * Authenticated with our own token, so clicking "new workspace" does not send
 * the user back through the browser for an identity the server can already see
 * (STORAGE.md §10.4).
 */
export const createWorkspaceAuthed = async (
  accessToken: string, deviceId: string, workspaceName: string, handle: string,
): Promise<OurSession> =>
  toSession(await post<RawSession>('/auth/workspace', {
    device_id: deviceId, workspace_name: workspaceName, handle,
  }, accessToken));

export const refreshSession = async (refreshToken: string): Promise<OurSession> =>
  toSession(await post<RawSession>('/auth/refresh', { refresh_token: refreshToken }));

/**
 * A session for a DIFFERENT workspace of the same identity (STORAGE.md §10.2).
 *
 * Called ONCE per workspace, ever — the first time it is opened on this device.
 * Afterwards that workspace has its own refresh token on disk and refreshes
 * like any other. The source session is not revoked, so the workspace being
 * left stays drainable and returnable-to offline.
 */
export const switchSession = async (
  refreshToken: string, workspaceId: string,
): Promise<OurSession> =>
  toSession(await post<RawSession>('/auth/switch', {
    refresh_token: refreshToken, workspace_id: workspaceId,
  }));

export interface Invitation { id: string; email: string; state: string; expires_at: string }

/**
 * Invitations are proxied through the sync process because the renderer never
 * holds a token (DESIGN.md §13.1). The server decides whether the caller may
 * invite — the client's own can() only decides whether to show the control
 * (AUTHZ.md §3, invariant 49).
 */
export const listInvitations = async (accessToken: string): Promise<{ invitations: Invitation[] }> =>
  get<{ invitations: Invitation[] }>('/invitations', accessToken);

export const createInvite = async (
  accessToken: string, email: string,
): Promise<{ invitation: Invitation }> =>
  post<{ invitation: Invitation }>('/invitations', { email }, accessToken);

export const revokeInvite = async (
  accessToken: string, id: string,
): Promise<{ invitation: Invitation }> =>
  post<{ invitation: Invitation }>(`/invitations/${encodeURIComponent(id)}/revoke`, {}, accessToken);

/** Materialise the actor for a workspace we were admitted to (§9). */
export const joinWorkspace = async (
  workosAccessToken: string, deviceId: string, workspaceId: string, handle: string,
): Promise<OurSession> =>
  toSession(await post<RawSession>('/auth/join', {
    workos_access_token: workosAccessToken, device_id: deviceId,
    workspace_id: workspaceId, handle,
  }));

export interface DirectoryActor {
  id: string; workspaceId: string; type: 'human' | 'agent';
  handle: string; displayName: string; avatarUrl: string | null;
  ownerActorId: string | null; state: string; updatedAt: number;
}

/**
 * The workspace directory. Replaced by DESIGN.md §9.1's `welcome` frame in
 * Phase 2 — same shape, different transport.
 */
export async function fetchActors(accessToken: string): Promise<DirectoryActor[]> {
  const raw = await get<{ actors: Record<string, unknown>[] }>('/actors', accessToken);
  return (raw.actors ?? []).map(a => ({
    id: String(a['id']), workspaceId: String(a['workspace_id']),
    type: a['type'] === 'agent' ? 'agent' : 'human',
    handle: String(a['handle']), displayName: String(a['display_name']),
    avatarUrl: (a['avatar_url'] as string | null) ?? null,
    ownerActorId: (a['owner_actor_id'] as string | null) ?? null,
    state: String(a['state']), updatedAt: Number(a['updated_at'] ?? 0),
  }));
}

export const signOutSession = (refreshToken: string): Promise<unknown> =>
  post('/auth/signout', { refresh_token: refreshToken });

export async function fetchMe(accessToken: string): Promise<Actor> {
  const res = await fetch(`${baseUrl()}/auth/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new ServerError('me failed', 'me_failed', res.status);
  const j = await res.json() as { actor: Record<string, string | null> };
  return {
    id: String(j.actor['id']), handle: String(j.actor['handle']),
    displayName: String(j.actor['display_name']), avatarUrl: j.actor['avatar_url'] ?? null,
    orgId: String(j.actor['org_id']), workspaceId: String(j.actor['workspace_id']),
  };
}
