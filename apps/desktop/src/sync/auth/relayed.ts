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

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
}

const toSession = (raw: RawSession): OurSession => ({
  accessToken: raw.access_token ?? '',
  refreshToken: raw.refresh_token ?? '',
  expiresAt: Date.now() + (raw.expires_in ?? 900) * 1000,
  actor: raw.actor
    ? { id: raw.actor.actorId, handle: '', displayName: '', avatarUrl: null,
        orgId: raw.actor.orgId, workspaceId: raw.actor.workspaceId }
    : null,
});

/** Trade a verified WorkOS token for our session. */
export async function exchangeForSession(
  workosAccessToken: string, deviceId: string,
): Promise<OurSession | NeedsWorkspace> {
  const raw = await post<RawSession>('/auth/session', {
    workos_access_token: workosAccessToken, device_id: deviceId,
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

export const refreshSession = async (refreshToken: string): Promise<OurSession> =>
  toSession(await post<RawSession>('/auth/refresh', { refresh_token: refreshToken }));

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
