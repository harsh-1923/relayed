// Who is making an HTTPS request, from our own bearer token.
//
// Moved out of `invitations.ts` when agent routes needed the same answer: two
// copies of "a token is valid AND its actor still exists and is active" is two
// places for the second half to be forgotten (DESIGN.md §6.3 — tokens outlive
// deactivation by their whole TTL, so the row decides).
import { db } from '../db/client.ts';
import { verifyAccessToken } from './tokens.ts';

export interface Caller {
  actorId: string;
  workspaceId: string;
  orgId: string;
  workosUserId: string | null;
}

/** The actor behind `Authorization: Bearer …`, or null for anything else. */
export async function caller(authorization: string | undefined): Promise<Caller | null> {
  const token = (authorization ?? '').startsWith('Bearer ') ? (authorization ?? '').slice(7) : '';
  if (!token) return null;
  try {
    const claims = await verifyAccessToken(token);
    const actor = await db.selectFrom('actors')
      .select(['identity_id', 'state'])
      .where('id', '=', claims.actorId).executeTakeFirst();
    if (!actor || actor.state !== 'active') return null;
    return { actorId: claims.actorId, workspaceId: claims.workspaceId,
             orgId: claims.orgId, workosUserId: actor.identity_id };
  } catch { return null; }
}
