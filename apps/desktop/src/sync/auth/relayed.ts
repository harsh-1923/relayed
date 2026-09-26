import { createHash } from 'node:crypto';
import { serverUrl } from '../config.ts';
import { logoDataUrl } from '../blobs.ts';
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
 * Two subjects, so every field says whose it is — see account migration v1.
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
  /** The organization it belongs to — the switcher groups by it (ORG-DOMAINS.md). */
  orgName: string;
  /**
   * Am I an admin of that org — owner or admin of its default workspace? Only
   * ever used to HIDE what the server would refuse (invariant 49).
   */
  orgIsAdmin: boolean;
  /** The org's default workspace: where a colleague joining by domain lands. */
  isDefault: boolean;
}

/**
 * A company org this person could join by their verified email domain, without
 * an invitation (ORG-DOMAINS.md §4). Joined exactly like a pending join —
 * `/auth/join` with `workspaceId`, which is the org's default workspace.
 */
export interface OrgMatch {
  orgId: string;
  name: string;
  memberCount: number;
  workspaceId: string;
  workspaceName: string;
  handleSuggestions: string[];
  /** Its logo, inline. Null draws initials. */
  logo: string | null;
  /** The org's default workspace — where colleagues land. */
  isDefault: boolean;
  /** Active people in this workspace (`memberCount` is the org's). */
  workspaceMemberCount: number;
}

/** A workspace we were admitted to in WorkOS and have no actor for yet (§9). */
export interface PendingJoin {
  workspaceId: string;
  orgId: string;
  name: string;
  handleSuggestions: string[];
  /** Invited here; in the org by a domain verified in WorkOS; or in the org some other way (join.ts). */
  reason: 'invited' | 'company' | 'member';
  /** Its logo, inline — the renderer cannot load a remote image. Null draws initials. */
  logo: string | null;
  /** The org's default workspace — where colleagues land. */
  isDefault: boolean;
  /** Its organization's name. */
  orgName: string;
  /** Active people in this workspace. */
  memberCount: number;
  /** Invite-only — offered because they were invited. */
  inviteOnly: boolean;
}

/** Returned when the identity has no organization yet (§9 decision 1). */
export interface NeedsWorkspace {
  needsWorkspace: true;
  identity: { email: string; displayName: string };
  handleSuggestions: string[];
  /** An invited person has no org of their own — and must not be pushed into
   *  creating one, which reads as a broken invite. */
  pendingJoins: PendingJoin[];
  /** Company orgs their email domain admits them to. Shown beside creating one, never instead. */
  orgMatches: OrgMatch[];
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

const baseUrl = serverUrl;

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

/** Open the DM or group DM with these people, the caller always included (DESIGN.md §7.1). */
export const openDm = (accessToken: string, input: { workspaceId: string; actorIds: string[] }) =>
  request<{ space_id: string; chat_id: string; created: boolean }>('POST', '/dms', accessToken, {
    workspace_id: input.workspaceId, actor_ids: input.actorIds,
  });

// `messageId` is the marker's client-generated id (SPACE-MEMBERSHIP-MARKERS.md):
// every add produces a chat message alongside the membership, and this add
// mints its id the same way any other send does — in the main process, since
// `sync/ids.ts` is Node-only and never reaches the renderer.
export const addSpaceMember = (accessToken: string, spaceId: string, actorId: string, messageId: string) =>
  request<{ space_id: string; actor_id: string; message_id: string }>('POST',
    `/spaces/${encodeURIComponent(spaceId)}/members`, accessToken,
    { actor_id: actorId, message_id: messageId });
/** Start a side chat in a room (docs/SIDE-CHATS.md). The ids are the client's, so a retry is the same chat. */
export const createSideChat = (accessToken: string, spaceId: string, input: {
  chatId: string; panelId: string; messageId: string; name: string; kind: 'public'; withActorIds: string[];
}) =>
  request<{ space_id: string; chat_id: string; panel_id: string; created: boolean }>('POST',
    `/spaces/${encodeURIComponent(spaceId)}/chats`, accessToken, {
      chat_id: input.chatId, panel_id: input.panelId, message_id: input.messageId,
      name: input.name, kind: input.kind, with_actor_ids: input.withActorIds,
    });
/**
 * Refresh a room's summary now (DOCUMENTS.md §4.4). `too_soon` is the rate
 * limit answering, not a failure — the panel says so rather than retrying.
 */
export const refreshRoomSummary = (accessToken: string, spaceId: string) =>
  request<{ space_id: string; outcome: string }>('POST',
    `/spaces/${encodeURIComponent(spaceId)}/summary/refresh`, accessToken, {});

/** Stop a run in flight, invoker-only (WORKSPACE-AGENTS.md §5.8). */
export const stopAgentRun = (accessToken: string, runId: string) =>
  request<{ run_id: string; state: string }>('POST',
    `/agent-runs/${encodeURIComponent(runId)}/stop`, accessToken, {});

/** Mark an answer an agent gave without being asked as not helpful (AMBIENT-RESPONSES.md §10.2). */
export const dismissAmbient = (accessToken: string, messageId: string) =>
  request<{ message_id: string; dismissed: boolean }>('POST',
    `/ambient/${encodeURIComponent(messageId)}/dismiss`, accessToken, {});

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
                    handle_suggestions: string[]; reason?: 'invited' | 'company' | 'member'; logo_url?: string | null;
                    is_default?: boolean; org_name?: string; member_count?: number; invite_only?: boolean }[];
  org_matches?: RawOrgMatch[];
}

interface RawOrgMatch {
  org_id: string; name: string; member_count: number;
  workspace_id: string; workspace_name: string; handle_suggestions: string[];
  logo_url?: string | null; is_default?: boolean; workspace_member_count?: number;
}

const toOrgMatch = (m: RawOrgMatch): OrgMatch => ({
  orgId: m.org_id, name: m.name, memberCount: m.member_count ?? 0,
  workspaceId: m.workspace_id, workspaceName: m.workspace_name,
  handleSuggestions: m.handle_suggestions ?? [],
  logo: null, isDefault: m.is_default ?? true, workspaceMemberCount: m.workspace_member_count ?? 0,
});

/**
 * Fetch every option's logo into an inline image. Only the join surfaces need
 * it: they show workspaces the person is not in, and during onboarding there is
 * no account yet to hold blobs (see `logoDataUrl`).
 */
async function withLogos<T extends { logo: string | null }>(items: T[], urls: (string | null | undefined)[]): Promise<T[]> {
  const logos = await Promise.all(urls.map(u => logoDataUrl(u ?? null)));
  return items.map((it, i) => ({ ...it, logo: logos[i] ?? null }));
}

interface RawMembership {
  workspace_id: string; org_id: string; name: string; slug: string;
  workspace_avatar_url: string | null;
  actor_id: string; actor_handle: string; actor_display_name: string;
  actor_avatar_url: string | null; actor_role: Role;
  org_name?: string; org_is_admin?: boolean; workspace_is_default?: boolean;
}

const toMembership = (m: RawMembership): Membership => ({
  workspaceId: m.workspace_id, orgId: m.org_id, name: m.name, slug: m.slug,
  workspaceAvatarUrl: m.workspace_avatar_url ?? null,
  actorId: m.actor_id, actorHandle: m.actor_handle,
  actorDisplayName: m.actor_display_name, actorAvatarUrl: m.actor_avatar_url ?? null,
  actorRole: m.actor_role ?? 'member',
  // Defaulted for a server that predates organizations: the workspace's own
  // name, no admin, not the default — least privilege, as actor_role.
  orgName: m.org_name ?? m.name,
  orgIsAdmin: m.org_is_admin === true,
  isDefault: m.workspace_is_default === true,
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
    handleSuggestions: j.handle_suggestions ?? [], reason: j.reason ?? 'invited', logo: null,
    isDefault: j.is_default ?? true,
    orgName: j.org_name ?? j.name, memberCount: j.member_count ?? 0, inviteOnly: j.invite_only === true,
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
      pendingJoins: await withLogos((raw.pending_joins ?? []).map(j => ({
        workspaceId: j.workspace_id, orgId: j.org_id, name: j.name,
        handleSuggestions: j.handle_suggestions ?? [], reason: j.reason ?? 'invited', logo: null,
    isDefault: j.is_default ?? true,
    orgName: j.org_name ?? j.name, memberCount: j.member_count ?? 0, inviteOnly: j.invite_only === true,
      })), (raw.pending_joins ?? []).map(j => j.logo_url)),
      orgMatches: await withLogos((raw.org_matches ?? []).map(toOrgMatch), (raw.org_matches ?? []).map(m => m.logo_url)),
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
  accessToken: string, deviceId: string, workspaceName: string, handle: string, orgId?: string,
): Promise<OurSession> =>
  toSession(await post<RawSession>('/auth/workspace', {
    device_id: deviceId, workspace_name: workspaceName, handle,
    // Inside an org that exists — its admins' to do (ORG-DOMAINS.md §7.1).
    // Without it, a new org of the caller's own.
    ...(orgId ? { org_id: orgId } : {}),
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

/**
 * Materialise the actor for a workspace we were admitted to (§9).
 *
 * EITHER CREDENTIAL. Onboarding holds a WorkOS token and no session of ours;
 * somebody invited after they had already signed up holds the opposite, because
 * the WorkOS token is dropped the moment onboarding completes. The server takes
 * both, the same way /auth/workspace always has.
 */
export const joinWorkspace = async (
  proof: { workosAccessToken: string } | { bearer: string },
  deviceId: string, workspaceId: string, handle: string,
): Promise<OurSession> =>
  toSession(await post<RawSession>('/auth/join', {
    ...('workosAccessToken' in proof ? { workos_access_token: proof.workosAccessToken } : {}),
    device_id: deviceId, workspace_id: workspaceId, handle,
  }, 'bearer' in proof ? proof.bearer : undefined));

// ── organizations (ORG-DOMAINS.md) ─────────────────────────────────────────
//
// Commands over HTTPS, like invitations: each is a question only the server can
// answer now, and the renderer never holds the token to ask it.

/** What this person could join and has not: invitations accepted, and company orgs by domain. */
export async function orgMatches(accessToken: string): Promise<{ pendingJoins: PendingJoin[]; orgMatches: OrgMatch[] }> {
  const raw = await get<{ pending_joins: NonNullable<RawSession['pending_joins']>; org_matches: RawOrgMatch[] }>(
    '/org/matches', accessToken);
  return {
    pendingJoins: await withLogos(raw.pending_joins.map(j => ({
      workspaceId: j.workspace_id, orgId: j.org_id, name: j.name, handleSuggestions: j.handle_suggestions ?? [],
      reason: j.reason ?? 'invited', logo: null,
    isDefault: j.is_default ?? true,
    orgName: j.org_name ?? j.name, memberCount: j.member_count ?? 0, inviteOnly: j.invite_only === true,
    })), raw.pending_joins.map(j => j.logo_url)),
    orgMatches: await withLogos(raw.org_matches.map(toOrgMatch), raw.org_matches.map(m => m.logo_url)),
  };
}

export interface OrgWorkspace {
  workspaceId: string; name: string; slug: string;
  joinPolicy: 'org_open' | 'invite_only'; isDefault: boolean; memberCount: number; joined: boolean;
}
export interface OrgWorkspaces { org: { id: string; name: string; isAdmin: boolean }; workspaces: OrgWorkspace[] }

/** An org's workspaces: the open ones and mine for a member, all of them for an admin. */
export async function orgWorkspaces(accessToken: string, orgId: string): Promise<Answer<OrgWorkspaces>> {
  const raw = await request<{ org: { id: string; name: string; is_admin: boolean };
    workspaces: { workspace_id: string; name: string; slug: string; join_policy: 'org_open' | 'invite_only';
                  is_default: boolean; member_count: number; joined: boolean }[] }>(
    'GET', `/org/${encodeURIComponent(orgId)}/workspaces`, accessToken);
  if (!raw.ok) return raw;
  return {
    ok: true,
    org: { id: raw.org.id, name: raw.org.name, isAdmin: raw.org.is_admin },
    workspaces: raw.workspaces.map(w => ({
      workspaceId: w.workspace_id, name: w.name, slug: w.slug, joinPolicy: w.join_policy,
      isDefault: w.is_default, memberCount: w.member_count, joined: w.joined,
    })),
  };
}

/** `source`: approved in Relayed (`app`), or verified on the org in WorkOS (`workos`) — WorkOS's to remove. */
export interface OrgDomain { domain: string; approvedAt: string; verified: boolean; source: 'app' | 'workos' }
type RawDomains = { domains: { domain: string; approved_at: string; verified: boolean; source?: 'app' | 'workos' }[] };
const toDomains = (a: Answer<RawDomains>): Answer<{ domains: OrgDomain[] }> => a.ok
  ? { ok: true, domains: a.domains.map(d => ({
      domain: d.domain, approvedAt: d.approved_at, verified: d.verified, source: d.source ?? 'app',
    })) }
  : a;

export const orgDomains = async (accessToken: string, orgId: string) =>
  toDomains(await request<RawDomains>('GET', `/org/${encodeURIComponent(orgId)}/domains`, accessToken));
/** Refusals are answers: `not_your_domain`, `public_domain`, `invalid_domain`, `email_unverified`. */
export const addOrgDomain = async (accessToken: string, orgId: string, domain: string) =>
  toDomains(await request<RawDomains>('POST', `/org/${encodeURIComponent(orgId)}/domains`, accessToken, { domain }));
export const removeOrgDomain = async (accessToken: string, orgId: string, domain: string) =>
  toDomains(await request<RawDomains>('DELETE',
    `/org/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domain)}`, accessToken));

/** An org admin's settings for one workspace: who may join it, and whether it is the default. */
export const updateOrgWorkspace = (
  accessToken: string, workspaceId: string, change: { joinPolicy?: 'org_open' | 'invite_only'; makeDefault?: boolean },
) => request<{ ok: true }>('PATCH', `/workspaces/${encodeURIComponent(workspaceId)}`, accessToken, {
  ...(change.joinPolicy ? { join_policy: change.joinPolicy } : {}),
  ...(change.makeDefault ? { make_default: true } : {}),
});

// ── files (FILES.md) ───────────────────────────────────────────────────────
//
// The handshake of §4.1: declare, PUT straight to the store, then ask the
// server to verify. The bytes never pass through our API on the way in, and the
// PUT URL is bound to exactly these bytes' hash, so nothing else can land.

/** Upload bytes for `purpose`. Answers with the file id, or the server's refusal. */
export async function uploadFile(
  accessToken: string, bytes: Uint8Array, mediaType: string, purpose: 'logo',
  // Whose logo it becomes — the server files it under that org, which need not
  // be the one this session is in.
  target: { org_id: string } | { workspace_id: string },
): Promise<Answer<{ file_id: string; url: string }>> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const declared = await request<{ file_id: string; ready: boolean; url?: string;
    upload?: { method: 'PUT'; url: string; headers: Record<string, string> } }>(
    'POST', '/files', accessToken, { purpose, sha256, size: bytes.byteLength, media_type: mediaType, ...target });
  if (!declared.ok) return declared;
  if (declared.ready) return { ok: true, file_id: declared.file_id, url: declared.url ?? `/files/${declared.file_id}` };

  const up = declared.upload!;
  let put: Response;
  try {
    put = await fetch(up.url, { method: 'PUT', headers: up.headers, body: bytes, signal: AbortSignal.timeout(60_000) });
  } catch (e) { throw new ServerError((e as Error).message, 'network', 0); }
  if (!put.ok) return { ok: false, status: put.status, error: 'upload_failed' };

  return request<{ file_id: string; url: string }>(
    'POST', `/files/${encodeURIComponent(declared.file_id)}/complete`, accessToken, {});
}

/** Point an org's logo at an uploaded file, or clear it with `null`. Org admins only. */
export const setOrgLogo = (accessToken: string, orgId: string, fileId: string | null) =>
  request<{ logo_url: string | null }>('PUT', `/org/${encodeURIComponent(orgId)}/logo`, accessToken, { file_id: fileId });

/** A workspace's own logo, over its org's. Its admins, or the org's. */
export const setWorkspaceLogo = (accessToken: string, workspaceId: string, fileId: string | null) =>
  request<{ logo_url: string | null }>('PUT', `/workspaces/${encodeURIComponent(workspaceId)}/logo`, accessToken, { file_id: fileId });

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
