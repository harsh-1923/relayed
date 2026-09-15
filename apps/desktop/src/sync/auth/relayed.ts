import type { Role } from '@relayed/authz';
import { firstString } from './json.ts';

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
    throw new ServerError(firstString(json['detail'], json['error'], res.statusText),
                          firstString(json['error'], `http_${res.status}`), res.status);
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
      firstString(json['detail'], json['error'], res.statusText),
      firstString(json['error'], `http_${res.status}`),
      res.status,
    );
  }
  return json as T;
}

/**
 * A request whose refusal is an ANSWER, not an exception: the agent editor has
 * to put "that handle is taken" beside the handle field, and an error thrown
 * across the port arrives as a message and nothing else. Only a network
 * failure throws.
 */
export type Answer<T> =
  | ({ ok: true } & T)
  | { ok: false; status: number; error: string; field?: string; reason?: string; action?: string };

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, bearer: string, body?: unknown,
): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new ServerError((e as Error).message, 'network', 0);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, ...(json as T) };
  const refusal: Extract<Answer<T>, { ok: false }> = {
    ok: false, status: res.status,
    error: typeof json['error'] === 'string' ? json['error'] : `http_${res.status}`,
  };
  for (const key of ['field', 'reason', 'action'] as const) {
    const value = json[key];
    if (typeof value === 'string') refusal[key] = value;
  }
  return refusal;
}

/** The fields of the agent editor, as the server's routes name them. */
export interface AgentInput {
  name?: string;
  handle?: string;
  description?: string;
  instructions?: string;
  model?: string | null;
  space_ids?: string[];
}

// Agents (WORKSPACE-AGENTS.md §4). Commands over HTTPS, as invitations are
// (the plan's D3): each needs a check the server must answer now.
export const agentHandle = (accessToken: string, handle: string, except?: string) =>
  request<{ handle: string; available: boolean; reason: string | null }>('GET',
    `/agents/handles/${encodeURIComponent(handle)}${except ? `?except=${encodeURIComponent(except)}` : ''}`,
    accessToken);
export const createAgent = (accessToken: string, input: AgentInput) =>
  request<{ agent_id: string }>('POST', '/agents', accessToken, input);
export const updateAgent = (accessToken: string, agentId: string, input: AgentInput) =>
  request<{ agent_id: string }>('PATCH', `/agents/${encodeURIComponent(agentId)}`, accessToken, input);
export const deactivateAgent = (accessToken: string, agentId: string) =>
  request<{ agent_id: string; state: string }>('POST', `/agents/${encodeURIComponent(agentId)}/deactivate`, accessToken, {});
export const setAgentMaintainers = (accessToken: string, agentId: string, actorIds: string[]) =>
  request<{ agent_id: string; maintainers: string[] }>('PUT',
    `/agents/${encodeURIComponent(agentId)}/maintainers`, accessToken, { actor_ids: actorIds });
export interface SpaceInput {
  workspaceId: string;
  kind: 'channel' | 'room';
  name: string;
  visibility: 'public' | 'private';
}

export const createSpace = (accessToken: string, input: SpaceInput) =>
  request<{ space_id: string; chat_id: string }>('POST', '/spaces', accessToken, {
    workspace_id: input.workspaceId, kind: input.kind, name: input.name, visibility: input.visibility,
  });

// `messageId` is the marker's client-generated id (SPACE-MEMBERSHIP-MARKERS.md):
// every add produces a chat message alongside the membership, and this add
// mints its id the same way any other send does — in the main process, since
// `sync/ids.ts` is Node-only and never reaches the renderer.
export const addSpaceMember = (accessToken: string, spaceId: string, actorId: string, messageId: string) =>
  request<{ space_id: string; actor_id: string; message_id: string }>('POST',
    `/spaces/${encodeURIComponent(spaceId)}/members`, accessToken,
    { actor_id: actorId, message_id: messageId });
/** Stop a run in flight, invoker-only (WORKSPACE-AGENTS.md §5.8). */
export const stopAgentRun = (accessToken: string, runId: string) =>
  request<{ run_id: string; state: string }>('POST',
    `/agent-runs/${encodeURIComponent(runId)}/stop`, accessToken, {});

// ── connections, through Composio (WORKSPACE-AGENTS.md §6) ─────────────────

export interface ToolkitSummary {
  slug: string; name: string; description: string; logoUrl: string | null;
  categories: string[]; authScheme: string; deprecated: boolean;
}

/** The offered catalogue (online-only, §7.1) — enabled toolkits only. */
export async function listToolkits(accessToken: string): Promise<{ toolkits: ToolkitSummary[] }> {
  const raw = await get<{ toolkits: { slug: string; name: string; description: string;
    logo_url: string | null; categories: string[]; auth_scheme: string; deprecated: boolean }[] }>(
    '/toolkits', accessToken);
  return {
    toolkits: raw.toolkits.map(t => ({
      slug: t.slug, name: t.name, description: t.description, logoUrl: t.logo_url,
      categories: t.categories, authScheme: t.auth_scheme, deprecated: t.deprecated,
    })),
  };
}

/** Start a connect attempt (§6.5). `port`/`state` are the caller's own loopback listener's. */
export const startConnection = (
  accessToken: string, input: { toolkit: string; port: number; state: string; accessRequestId?: string },
) => request<{ connection_id: string; start_url: string }>('POST', '/connections', accessToken, {
  toolkit: input.toolkit, port: input.port, state: input.state,
  ...(input.accessRequestId ? { access_request_id: input.accessRequestId } : {}),
});

/** The loopback listener's own call, once its `state` check passes (§6.5). */
export const completeConnection = (accessToken: string, connectionId: string, sessionUri: string) =>
  request<{ connection_id: string; status: string }>('POST',
    `/connections/${encodeURIComponent(connectionId)}/complete`, accessToken, { session_uri: sessionUri });

/**
 * Tell the server a connect attempt did not finish, so the row does not sit
 * at "connecting" forever (§6.5). Best effort: called from a `catch`, where a
 * second failure has nowhere left to go.
 */
export const failConnection = (accessToken: string, connectionId: string) =>
  request<{ connection_id: string; status: string }>('POST',
    `/connections/${encodeURIComponent(connectionId)}/fail`, accessToken);

/** Revoke then delete, best effort either way (§6.10). */
export const disconnectConnection = (accessToken: string, connectionId: string) =>
  request<{ connection_id: string; status: string; revoked: boolean }>('DELETE',
    `/connections/${encodeURIComponent(connectionId)}`, accessToken);

/** Grant at the agent's current highest effect in this toolkit — never a client-chosen one (§6.4). */
export const grantAgentPermission = (accessToken: string, agentId: string, toolkit: string) =>
  request<{ agent_id: string; toolkit: string; effect: string }>('PUT',
    `/agent-permissions/${encodeURIComponent(agentId)}/${encodeURIComponent(toolkit)}`, accessToken, {});

/** Revoke: only this agent loses it (§6.4). */
export const revokeAgentPermission = (accessToken: string, agentId: string, toolkit: string) =>
  request<{ agent_id: string; toolkit: string; revoked: boolean }>('DELETE',
    `/agent-permissions/${encodeURIComponent(agentId)}/${encodeURIComponent(toolkit)}`, accessToken);

/** The card's own Allow (§7.4) — the same grant as `grantAgentPermission`, reached from the request instead of the connector store. */
export const allowAccessRequest = (accessToken: string, requestId: string) =>
  request<{ request_id: string; state: string; effect?: string }>('POST',
    `/access-requests/${encodeURIComponent(requestId)}/allow`, accessToken, {});

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
