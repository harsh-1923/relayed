// Channel and room creation and space membership commands over HTTPS.
//
// They are commands rather than replica reads: changing who receives a space
// needs a live, authoritative permission check and commits immediately. The
// resulting space event is still the one thing that updates clients.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { caller as bearerCaller, type Caller } from '../auth/caller.ts';
import { Forbidden } from '../authz/can.ts';
import type { AppendedEvent } from './events.ts';
import type { FanoutResult } from './fanout.ts';
import {
  createChannel, createRoom, spaceNameFrom, UnknownWorkspaceError, addToSpace, SealedSpaceError, SpaceMemberUnavailableError,
  openDm, InvalidDmMembersError, DM_MAX_MEMBERS,
} from './spaces.ts';

export interface SpaceRouteDeps {
  db: Kysely<DB>;
  deliver: (event: AppendedEvent) => Promise<FanoutResult>;
  /** Injected so route tests need no signing key. */
  caller?: (authorization: string | undefined) => Promise<Caller | null>;
}

function refusal(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof Forbidden) {
    return reply.code(403).send({ error: 'forbidden', action: error.action });
  }
  if (error instanceof SpaceMemberUnavailableError) {
    return reply.code(404).send({ error: 'actor_unavailable', field: 'actor_id' });
  }
  if (error instanceof SealedSpaceError) {
    return reply.code(403).send({ error: 'sealed_space', space_id: error.spaceId });
  }
  throw error;
}

export function spaceRoutes(deps: SpaceRouteDeps) {
  const who = deps.caller ?? bearerCaller;

  return async function register(app: FastifyInstance): Promise<void> {
    app.post<{ Body: { kind?: unknown; name?: unknown; visibility?: unknown; workspace_id?: unknown } }>(
      '/spaces', async (req, reply) => {
        const me = await who(req.headers.authorization);
        if (!me) return reply.code(401).send({ error: 'unauthenticated' });
        // Bind the command to the workspace where its dialog was opened. A
        // concurrent workspace switch must not create it under a newer token.
        if (req.body?.workspace_id !== me.workspaceId) {
          return reply.code(403).send({ error: 'forbidden', action: 'create_space' });
        }
        const { kind, name, visibility } = req.body;
        if (kind !== 'channel' && kind !== 'room') {
          return reply.code(400).send({ error: 'invalid', field: 'kind' });
        }
        const spaceName = spaceNameFrom(name);
        if (!spaceName) {
          return reply.code(400).send({ error: 'invalid', field: 'name' });
        }
        if (visibility !== 'public' && visibility !== 'private') {
          return reply.code(400).send({ error: 'invalid', field: 'visibility' });
        }
        try {
          const create = kind === 'channel' ? createChannel : createRoom;
          const result = await create(deps.db, {
            workspaceId: me.workspaceId, createdBy: me.actorId, name: spaceName, visibility,
          });
          for (const event of result.events) await deps.deliver(event);
          return reply.code(201).send({ space_id: result.spaceId, chat_id: result.chatId });
        } catch (error) {
          if (error instanceof UnknownWorkspaceError) {
            return reply.code(404).send({ error: 'workspace_unavailable' });
          }
          return refusal(reply, error);
        }
      },
    );

    /**
     * Open the DM or group DM with these people — the one already there, or a
     * new one (DESIGN.md §7.1). `actor_ids` are the others; the caller is always
     * in it. 201 when it was made, 200 when it already existed.
     */
    app.post<{ Body: { workspace_id?: unknown; actor_ids?: unknown } }>(
      '/dms', async (req, reply) => {
        const me = await who(req.headers.authorization);
        if (!me) return reply.code(401).send({ error: 'unauthenticated' });
        if (req.body?.workspace_id !== me.workspaceId) {
          return reply.code(403).send({ error: 'forbidden', action: 'create_space' });
        }
        const actorIds = req.body?.actor_ids;
        if (!Array.isArray(actorIds) || actorIds.some(id => typeof id !== 'string' || id.length === 0)) {
          return reply.code(400).send({ error: 'invalid', field: 'actor_ids' });
        }
        try {
          const opened = await openDm(deps.db, {
            workspaceId: me.workspaceId, openedBy: me.actorId, withActorIds: actorIds as string[],
          });
          for (const event of opened.events) await deps.deliver(event);
          return reply.code(opened.created ? 201 : 200)
            .send({ space_id: opened.spaceId, chat_id: opened.chatId, created: opened.created });
        } catch (error) {
          if (error instanceof InvalidDmMembersError) {
            return reply.code(400).send({ error: 'invalid', field: 'actor_ids', reason: error.reason, max: DM_MAX_MEMBERS });
          }
          if (error instanceof UnknownWorkspaceError) {
            return reply.code(404).send({ error: 'workspace_unavailable' });
          }
          return refusal(reply, error);
        }
      },
    );

    app.post<{ Params: { id: string }; Body: { actor_id?: unknown; message_id?: unknown } }>(
      '/spaces/:id/members', async (req, reply) => {
        const me = await who(req.headers.authorization);
        if (!me) return reply.code(401).send({ error: 'unauthenticated' });
        const actorId = req.body?.actor_id;
        if (typeof actorId !== 'string' || actorId.length === 0) {
          return reply.code(400).send({ error: 'invalid', field: 'actor_id', reason: 'required' });
        }
        // The marker's client-generated id: this add always produces a chat
        // message alongside the membership (SPACE-MEMBERSHIP-MARKERS.md), and
        // the client mints its id the same way it mints one for any send.
        const messageId = req.body?.message_id;
        if (typeof messageId !== 'string' || messageId.length === 0) {
          return reply.code(400).send({ error: 'invalid', field: 'message_id', reason: 'required' });
        }
        try {
          const result = await addToSpace(deps.db, req.params.id, actorId, me.actorId, messageId);
          if (result.status === 'already_member') {
            return reply.code(409).send({ error: 'already_member', space_id: req.params.id, actor_id: actorId });
          }
          // Membership before the marker: a client that applies both
          // synchronously already has the membership by the time it needs to
          // explain who the marker names.
          await deps.deliver(result.membershipEvent);
          await deps.deliver(result.messageEvent);
          return reply.send({ space_id: req.params.id, actor_id: actorId, message_id: messageId });
        } catch (error) {
          return refusal(reply, error);
        }
      },
    );
  };
}
