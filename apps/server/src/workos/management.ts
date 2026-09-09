// The WorkOS Management API (PHASE-1-IDENTITY.md §9, AUTHZ.md §8).
//
// Distinct from the auth path on purpose. AuthKit answers "who is this" and is
// on the critical path of a sign-in; this answers "what organizations exist"
// and is on the critical path of onboarding only. Steady-state sync touches
// neither (DESIGN.md §9.7).
//
// Calling this during onboarding adds no NEW dependency: AuthKit has already
// had to be reachable to authenticate the person standing in front of us. That
// is what makes a synchronous call here acceptable where one on the sync path
// would not be.
import { env } from '../env.ts';

const BASE = 'https://api.workos.com';

export class WorkOSError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'WorkOSError';
    this.status = status;
    this.code = code;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Absent rather than wrong: a missing key is a configuration error and must
  // not read as a WorkOS outage.
  if (!env.workosApiKey) throw new WorkOSError('WORKOS_API_KEY is not set', 0, 'unconfigured');

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${env.workosApiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    // Unreachable is distinguished from rejected: one is worth retrying and the
    // other never will be.
    throw new WorkOSError((e as Error).message, 0, 'network');
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new WorkOSError(
      String(json['message'] ?? json['error_description'] ?? res.statusText),
      res.status, String(json['code'] ?? json['error'] ?? `http_${res.status}`));
  }
  return json as T;
}

export interface WorkOSOrganization { id: string; name: string }

/**
 * Create the organization SSO, Directory Sync and invitations all attach to.
 *
 * Until this existed, `organizations.workos_org_id` held `pending_<our id>` and
 * our users belonged to no WorkOS organization at all — which invitations
 * cannot work around, since an invitation is addressed to an organization.
 */
export const createOrganization = (name: string): Promise<WorkOSOrganization> =>
  call<WorkOSOrganization>('POST', '/organizations', { name });

export interface WorkOSMembership {
  id: string;
  user_id: string;
  organization_id: string;
  role?: { slug: string };
}

/**
 * Creating the organization is not enough, and this is the step easiest to
 * forget: without a membership WorkOS does not consider the founder to be in
 * their own organization, so invitations have nothing to attach to and a later
 * Directory Sync would reconcile against an empty org.
 */
export const addMember = (organizationId: string, userId: string): Promise<WorkOSMembership> =>
  call<WorkOSMembership>('POST', '/user_management/organization_memberships',
                         { organization_id: organizationId, user_id: userId });

export const listMemberships = (userId: string): Promise<{ data: WorkOSMembership[] }> =>
  call('GET', `/user_management/organization_memberships?user_id=${encodeURIComponent(userId)}`);

export interface WorkOSInvitation {
  id: string;
  email: string;
  state: 'pending' | 'accepted' | 'expired' | 'revoked';
  organization_id: string | null;
  accept_invitation_url: string;
  expires_at: string;
}

/**
 * Email is a PASS-THROUGH here and nowhere else. §6.2 forbids keying anything
 * on it; an invitation is inherently addressed to one, so WorkOS holds it and
 * we hand it over without ever writing it down.
 */
export const createInvitation = (
  organizationId: string, email: string, inviterUserId?: string,
): Promise<WorkOSInvitation> =>
  call<WorkOSInvitation>('POST', '/user_management/invitations', {
    email, organization_id: organizationId,
    ...(inviterUserId ? { inviter_user_id: inviterUserId } : {}),
  });

export const listInvitations = (organizationId: string): Promise<{ data: WorkOSInvitation[] }> =>
  call('GET', `/user_management/invitations?organization_id=${encodeURIComponent(organizationId)}`);

export const revokeInvitation = (id: string): Promise<WorkOSInvitation> =>
  call<WorkOSInvitation>('POST', `/user_management/invitations/${encodeURIComponent(id)}/revoke`);

// ── the Events API ─────────────────────────────────────────────────────────
//
// A durable, ordered, replayable log — which is why this is polled rather than
// pushed. `after` is a cursor over a total order, so nothing can be missed,
// nothing arrives twice without being recognisable, and a bug is recovered from
// by rewinding rather than by asking WorkOS to resend.
//
// One call covers every event type; the parameter takes a comma-separated list.

/** The events we act on. Anything not listed here is not delivered at all. */
export const WATCHED_EVENTS = [
  'organization_membership.created',
  'organization_membership.updated',
  'organization_membership.deleted',
  'user.deleted',
] as const;

export interface WorkOSEvent {
  id: string;
  event: string;
  created_at: string;
  data: {
    id?: string;
    user_id?: string;
    organization_id?: string;
    status?: string;
    role?: { slug?: string };
  };
}

export const listEvents = (
  after: string | null, limit = 100,
): Promise<{ data: WorkOSEvent[]; list_metadata: { after: string | null } }> =>
  call('GET', `/events?limit=${limit}&events=${WATCHED_EVENTS.join(',')}`
            + (after ? `&after=${encodeURIComponent(after)}` : ''));
