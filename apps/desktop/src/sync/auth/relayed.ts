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
  /**
   * EVERY workspace this identity belongs to (STORAGE.md §10.1). Populated by
   * /auth/session, /auth/workspace and /auth/refresh; empty from /auth/switch,
   * which is scoped to one workspace and says nothing new about the others.
   */
  memberships: Membership[];
}

/** One row of the switcher, cached in account.db (STORAGE.md §6). */
export interface Membership {
  workspaceId: string;
  orgId: string;
  name: string;
  slug: string;
  actorId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Returned when the identity has no organization yet (§9 decision 1). */
export interface NeedsWorkspace {
  needsWorkspace: true;
  identity: { email: string; displayName: string };
  handleSuggestions: string[];
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
}

interface RawMembership {
  workspace_id: string; org_id: string; name: string; slug: string;
  actor_id: string; handle: string; display_name: string; avatar_url: string | null;
}

const toMembership = (m: RawMembership): Membership => ({
  workspaceId: m.workspace_id, orgId: m.org_id, name: m.name, slug: m.slug,
  actorId: m.actor_id, handle: m.handle, displayName: m.display_name,
  avatarUrl: m.avatar_url ?? null,
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
