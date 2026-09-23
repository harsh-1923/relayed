// "Not helpful here" on an unprompted answer (docs/AMBIENT-RESPONSES.md,
// signals §10.2): kept as feedback on that message in `agent_feedback`. It
// changes nothing about when the agent answers — it is for people to read.
import type { Kysely } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { can, chat as chatTarget } from '@relayed/authz';
import type { DB } from '../../db/schema.ts';
import { loadGrants } from '../../authz/can.ts';
import { caller as bearerCaller, type Caller } from '../../auth/caller.ts';
import { chatPlacement } from '../../sync/placement.ts';

export interface AmbientRouteDeps {
  db: Kysely<DB>;
  /** Who is asking. The bearer token by default; a test answers directly. */
  caller?: (authorization: string | undefined) => Promise<Caller | null>;
}

export function ambientRoutes(deps: AmbientRouteDeps) {
  const who = deps.caller ?? bearerCaller;

  return async function register(app: FastifyInstance): Promise<void> {
    /**
     * Anyone who can read the chat may mark an answer not helpful: it was
     * posted to all of them, unasked. Each person counts once, however many
     * times they press it — the first time is kept.
     *
     * NOT FOUND, never forbidden, for a message that is not an ambient answer
     * or one the caller cannot read: the answer they would get for an id that
     * does not exist, as a thread page gives (`sync/ops.ts`).
     */
    app.post<{ Params: { messageId: string } }>('/ambient/:messageId/dismiss', async (req, reply) => {
      const me = await who(req.headers.authorization);
      if (!me) return reply.code(401).send({ error: 'unauthenticated' });

      const decision = await deps.db.selectFrom('ambient_decisions')
        .select(['chat_id', 'workspace_id'])
        .where('reply_message_id', '=', req.params.messageId)
        .executeTakeFirst();
      if (!decision || decision.workspace_id !== me.workspaceId) return reply.code(404).send({ error: 'not_found' });

      const grants = await loadGrants(deps.db, me.actorId);
      if (!can(grants, 'read', chatTarget(decision.chat_id), await chatPlacement(deps.db, decision.chat_id))) {
        return reply.code(404).send({ error: 'not_found' });
      }

      await deps.db.insertInto('agent_feedback')
        .values({ message_id: req.params.messageId, actor_id: me.actorId, kind: 'not_helpful' })
        .onConflict((conflict) => conflict.columns(['message_id', 'actor_id', 'kind']).doNothing())
        .execute();
      return reply.send({ message_id: req.params.messageId, dismissed: true });
    });
  };
}
