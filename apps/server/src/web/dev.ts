// Routes that exist only on a developer's machine.
//
// Registered by `index.ts` only when RELAYED_DEV_ROUTES is set, and the server
// listens on 127.0.0.1 regardless. No authentication: a route that needed a
// session would need a signed-in client to call it, and the one below exists
// precisely to do by hand what no client can do at all.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { chat as chatTarget } from '@relayed/authz';
import type { DB } from '../db/schema.ts';
import { ulid } from '../db/ulid.ts';
import { canDb } from '../authz/can.ts';
import { chatPlacement } from '../sync/placement.ts';
import type { AppendedEvent } from '../sync/events.ts';
import type { FanoutResult } from '../sync/fanout.ts';
import { writeMessage, MessageNotFoundError, PartsRefusedError } from '../sync/ops.ts';
import { AudienceError } from '../sync/visibility.ts';
import { Forbidden } from '../authz/can.ts';

export interface DevDeps {
  db: Kysely<DB>;
  /** The socket's own delivery, so a message written here reaches clients as a real one would. */
  deliver: (event: AppendedEvent) => Promise<FanoutResult>;
}

interface RestrictedMessageBody {
  chatId?: unknown;
  authorId?: unknown;
  listed?: unknown;
  body?: unknown;
  parentId?: unknown;
}

const isIds = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0);

export function devRoutes(deps: DevDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    /**
     * Write a message only `listed` may see (WORKSPACE-AGENTS.md §12.2, step 1).
     *
     * Restricted messages are dormant — nothing in v1 writes one — so this is
     * their only writer, and it goes through `writeMessage` to meet the checks
     * a real one would: every listed actor must be able to read the chat, the
     * list must not be empty, and nothing may reply to a restricted message.
     * The author must be able to post there, which is what a client send would
     * check.
     *
     *   curl -X POST localhost:8787/dev/restricted-message \
     *     -H 'content-type: application/json' \
     *     -d '{"chatId":"cht_…","authorId":"act_…","listed":["act_…"],"body":"a private notice"}'
     */
    app.post<{ Body: RestrictedMessageBody }>('/dev/restricted-message', async (req, reply) => {
      const { chatId, authorId, listed, body, parentId } = req.body ?? {};
      if (typeof chatId !== 'string' || typeof authorId !== 'string'
          || typeof body !== 'string' || !isIds(listed)
          || (parentId !== undefined && parentId !== null && typeof parentId !== 'string')) {
        return reply.code(400).send({
          error: 'invalid_body',
          expected: '{ chatId, authorId, listed: string[], body, parentId? }',
        });
      }

      const placement = await chatPlacement(deps.db, chatId);
      if (!await canDb(deps.db, authorId, 'post', chatTarget(chatId), placement)) {
        return reply.code(403).send({ error: 'author_cannot_post' });
      }

      try {
        const { ack, event } = await deps.db.transaction().execute(trx => writeMessage(trx, {
          chatId, messageId: ulid('msg'), authorId, body,
          parentId: typeof parentId === 'string' ? parentId : null,
          audience: { kind: 'listed', actors: listed },
        }));
        // After the commit, as every writer must: delivering from inside the
        // transaction would tell clients about a message a rollback erased.
        const delivered = await deps.deliver(event);
        return reply.send({ id: ack.messageId, ord: ack.ord, rev: ack.rev, delivered });
      } catch (e) {
        if (e instanceof AudienceError) {
          return reply.code(400).send({ error: `audience_${e.reason}`, actor_id: e.actorId });
        }
        if (e instanceof MessageNotFoundError) return reply.code(404).send({ error: 'parent_not_found' });
        if (e instanceof Forbidden) return reply.code(403).send({ error: 'cannot_reply_to_restricted' });
        throw e;
      }
    });

    /**
     * Write a message made of PARTS, as its author (AGENT-RESPONSES.md, phase 3).
     *
     * What an agent run will do, before runs exist: the same `writeMessage`, so
     * the same checks — `tool` and `ui` only from an agent, every block valid,
     * `body` derived by the server. Posting parts for a person is how the
     * refusal is seen by hand.
     *
     *   curl -X POST localhost:8787/dev/agent-message \
     *     -H 'content-type: application/json' \
     *     -d '{"chatId":"cht_…","authorId":"act_<agent>","parts":[{"kind":"markdown","text":"Hello"}]}'
     */
    app.post<{ Body: { chatId?: unknown; authorId?: unknown; parts?: unknown; parentId?: unknown } }>(
      '/dev/agent-message', async (req, reply) => {
        const { chatId, authorId, parts, parentId } = req.body ?? {};
        if (typeof chatId !== 'string' || typeof authorId !== 'string' || !Array.isArray(parts)
            || (parentId !== undefined && parentId !== null && typeof parentId !== 'string')) {
          return reply.code(400).send({
            error: 'invalid_body', expected: '{ chatId, authorId, parts: Part[], parentId? }',
          });
        }
        const placement = await chatPlacement(deps.db, chatId);
        if (!await canDb(deps.db, authorId, 'post', chatTarget(chatId), placement)) {
          return reply.code(403).send({ error: 'author_cannot_post' });
        }
        try {
          const { ack, event } = await deps.db.transaction().execute(trx => writeMessage(trx, {
            chatId, messageId: ulid('msg'), authorId,
            parentId: typeof parentId === 'string' ? parentId : null,
            audience: { kind: 'stream' }, parts,
          }));
          const delivered = await deps.deliver(event);
          return reply.send({ id: ack.messageId, ord: ack.ord, rev: ack.rev, delivered });
        } catch (e) {
          if (e instanceof PartsRefusedError) {
            return reply.code(400).send({ error: 'parts_refused', reason: e.reason, detail: e.detail });
          }
          throw e;
        }
      });
  };
}
