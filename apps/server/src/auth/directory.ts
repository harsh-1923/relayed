// The workspace directory: every actor a client needs to render an author.
//
// TEMPORARY BY DESIGN. DESIGN.md §9.1 puts `actors` in the `welcome` frame, so
// this endpoint disappears the moment the socket exists — a client that has just
// connected needs the directory anyway, and fetching it over HTTP as well would
// be a second path to the same data.
//
// It exists now because Phase 2 cannot render a message author offline without
// a populated `actors` table, and the socket is Phase 2. The shape below is the
// shape `welcome` will carry, so porting is a change of transport.
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.ts';
import { verifyAccessToken } from './tokens.ts';

export async function directoryRoutes(app: FastifyInstance): Promise<void> {
  /** Every actor in the workspace this session is scoped to. */
  app.get('/actors', async (req, reply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return reply.code(401).send({ error: 'unauthenticated' });

    let claims;
    try { claims = await verifyAccessToken(token); }
    catch (e) { return reply.code(401).send({ error: 'invalid_token', detail: (e as Error).message }); }

    // Scoped by the TOKEN, never by a parameter: a workspace id in a request is
    // not evidence of membership in it.
    const actors = await db.selectFrom('actors')
      .select(['id', 'workspace_id', 'type', 'handle', 'display_name', 'avatar_url',
               'owner_actor_id', 'state', 'updated_at'])
      .where('workspace_id', '=', claims.workspaceId)
      .execute();

    // identity_kind and identity_id are deliberately NOT selected. They are
    // Layer 1 references (§6.3) and nothing on the client addresses an actor by
    // anything but actor_id — sending them would hand every member a directory
    // of everyone else's external identifiers for no feature.
    //
    // Deactivated actors ARE included: a tombstoned author still has to render
    // on messages they wrote (§6.3), and a client that dropped them would show
    // an empty name instead of a greyed one.
    return reply.send({
      actors: actors.map(a => ({
        id: a.id, workspace_id: a.workspace_id, type: a.type,
        handle: a.handle, display_name: a.display_name,
        avatar_url: a.avatar_url, owner_actor_id: a.owner_actor_id,
        state: a.state, updated_at: new Date(a.updated_at as unknown as string).getTime(),
      })),
    });
  });
}
