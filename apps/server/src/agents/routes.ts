// Agents over HTTPS: create, edit, deactivate, maintainers, and the live
// handle check (docs/WORKSPACE-AGENTS.md §4; the plan's D3).
//
// Commands, not outbox ops: each needs a live handle check or a permission the
// server must answer now, they are rare, and nobody creates an agent offline —
// the shape invitations already use. Every route asks `can()` through the
// domain functions in `definitions.ts`, and none tests a role itself.
//
// Events are delivered AFTER the transaction that wrote them commits, through
// the socket's own delivery: a new agent reaches every connected client's
// autocomplete at once.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { Forbidden } from '../authz/can.ts';
import { caller as bearerCaller, type Caller } from '../auth/caller.ts';
import type { AppendedEvent } from '../sync/events.ts';
import type { FanoutResult } from '../sync/fanout.ts';
import type { Registry } from '../sync/registry.ts';
import {
  createAgent, updateAgent, deactivateAgent, setMaintainers, handleAvailability,
  AgentInvalidError, HandleTakenError, AgentNotFoundError, AgentDeactivatedError, SystemAgentError,
  type AgentFields,
} from './definitions.ts';
import { triggerRef, claimReplyMessageId, postFinishedNotice } from './dispatcher.ts';
import type { FinishedRun } from './reply.ts';
import { replyParentOf } from './transcript.ts';

export interface AgentRouteDeps {
  db: Kysely<DB>;
  deliver: (event: AppendedEvent) => Promise<FanoutResult>;
  /** For the stop route's notice: fanned-out reply, and the working indicator's end (§5.7, §5.8). */
  registry: Registry;
  /** Aborts an in-flight run's runtime call; absent when the dispatcher never started (D5). */
  dispatcher?: { cancel(runId: string): void };
  /** Injected so a test needs no signing key; production reads the bearer token. */
  caller?: (authorization: string | undefined) => Promise<Caller | null>;
}

interface AgentBody {
  name?: unknown;
  handle?: unknown;
  description?: unknown;
  instructions?: unknown;
  model?: unknown;
  space_ids?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const ids = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every(x => typeof x === 'string') ? v : undefined;

/** The editor's fields, from a body that may hold anything. Absent stays absent. */
function fieldsOf(body: AgentBody): Partial<AgentFields> {
  const out: Partial<AgentFields> = {};
  for (const key of ['name', 'handle', 'description', 'instructions'] as const) {
    if (body[key] === undefined) continue;
    const value = str(body[key]);
    if (value === undefined) throw new AgentInvalidError(key, 'not_a_string');
    out[key] = value;
  }
  if (body.model !== undefined) {
    if (body.model !== null && typeof body.model !== 'string') throw new AgentInvalidError('model', 'not_a_string');
    out.model = body.model;
  }
  return out;
}

/** One mapping from a domain refusal to what the editor can put beside a field. */
function refuse(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AgentInvalidError) {
    return reply.code(400).send({ error: 'invalid', field: err.field, reason: err.reason });
  }
  if (err instanceof HandleTakenError) return reply.code(409).send({ error: 'handle_taken', field: 'handle' });
  if (err instanceof AgentDeactivatedError) return reply.code(409).send({ error: 'agent_deactivated' });
  if (err instanceof AgentNotFoundError) return reply.code(404).send({ error: 'not_found' });
  // 403, not 404: the agent is there and readable, and the answer is about
  // WHAT was asked rather than who asked it — no caller gets a different one.
  if (err instanceof SystemAgentError) return reply.code(403).send({ error: 'system_agent' });
  if (err instanceof Forbidden) return reply.code(403).send({ error: 'forbidden', action: err.action });
  throw err;
}

export function agentRoutes(deps: AgentRouteDeps) {
  const who = deps.caller ?? bearerCaller;
  const deliverAll = async (events: (AppendedEvent | null)[]): Promise<void> => {
    for (const event of events) if (event) await deps.deliver(event);
  };

  return async function register(app: FastifyInstance): Promise<void> {
    /** Whether a handle is free in the caller's workspace — checked as they type (§4.1). */
    app.get<{ Params: { handle: string }; Querystring: { except?: string } }>(
      '/agents/handles/:handle', async (req, reply) => {
        const me = await who(req.headers.authorization);
        if (!me) return reply.code(401).send({ error: 'unauthenticated' });
        return reply.send(await handleAvailability(deps.db, me.workspaceId, req.params.handle, req.query.except));
      });

    app.post<{ Body: AgentBody }>('/agents', async (req, reply) => {
      const me = await who(req.headers.authorization);
      if (!me) return reply.code(401).send({ error: 'unauthenticated' });
      try {
        const body = req.body ?? {};
        const fields = fieldsOf(body);
        const spaceIds = body.space_ids === undefined ? [] : ids(body.space_ids);
        if (spaceIds === undefined) throw new AgentInvalidError('space_ids', 'not_a_list');
        for (const key of ['name', 'handle', 'instructions'] as const) {
          if (fields[key] === undefined) throw new AgentInvalidError(key, 'required');
        }
        const { agentId, events } = await createAgent(deps.db, {
          workspaceId: me.workspaceId, createdBy: me.actorId,
          name: fields.name as string, handle: fields.handle as string,
          description: fields.description ?? '', instructions: fields.instructions as string,
          model: fields.model ?? null, spaceIds,
        });
        await deliverAll(events);
        return reply.code(201).send({ agent_id: agentId });
      } catch (err) { return refuse(reply, err); }
    });

    app.patch<{ Params: { id: string }; Body: AgentBody }>('/agents/:id', async (req, reply) => {
      const me = await who(req.headers.authorization);
      if (!me) return reply.code(401).send({ error: 'unauthenticated' });
      try {
        const event = await updateAgent(deps.db, {
          agentId: req.params.id, by: me.actorId, patch: fieldsOf(req.body ?? {}),
        });
        await deliverAll([event]);
        return reply.send({ agent_id: req.params.id });
      } catch (err) { return refuse(reply, err); }
    });

    app.post<{ Params: { id: string } }>('/agents/:id/deactivate', async (req, reply) => {
      const me = await who(req.headers.authorization);
      if (!me) return reply.code(401).send({ error: 'unauthenticated' });
      try {
        await deliverAll([await deactivateAgent(deps.db, { agentId: req.params.id, by: me.actorId })]);
        return reply.send({ agent_id: req.params.id, state: 'deactivated' });
      } catch (err) { return refuse(reply, err); }
    });

    /**
     * Stop a run in flight, invoker-only (§5.8): aborts the runtime call if one
     * is running, then writes the same "Stopped by X" notice a natural finish
     * would, through the shared `op_<runId>` ledger — so a `done` arriving at
     * the same moment loses the race rather than landing a second message.
     */
    app.post<{ Params: { id: string } }>('/agent-runs/:id/stop', async (req, reply) => {
      const me = await who(req.headers.authorization);
      if (!me) return reply.code(401).send({ error: 'unauthenticated' });

      const run = await deps.db.selectFrom('agent_runs')
        .select(['id', 'chat_id', 'agent_actor_id', 'invoker_actor_id', 'trigger_message_id',
                 'reply_message_id', 'state'])
        .where('id', '=', req.params.id).executeTakeFirst();
      if (!run) return reply.code(404).send({ error: 'not_found' });
      if (run.invoker_actor_id !== me.actorId) return reply.code(403).send({ error: 'forbidden', action: 'stop' });
      if (run.state !== 'queued' && run.state !== 'running') {
        return reply.send({ run_id: run.id, state: run.state });
      }

      deps.dispatcher?.cancel(run.id);

      const trigger = await triggerRef(deps.db, run.trigger_message_id, run.chat_id);
      const replyMessageId = run.reply_message_id ?? await claimReplyMessageId(deps.db, run.id);
      const finished: FinishedRun = {
        id: run.id, chatId: run.chat_id, agentActorId: run.agent_actor_id,
        invokerActorId: run.invoker_actor_id, replyMessageId,
        replyParentId: replyParentOf(trigger, run.trigger_message_id),
      };
      // The notice reads "Stopped by <name>" (§5.7) — a name, never the id
      // `can()` and everything else here works in.
      const stopper = await deps.db.selectFrom('actors').select('display_name')
        .where('id', '=', me.actorId).executeTakeFirst();
      await postFinishedNotice(deps.db, deps.registry, finished,
        { state: 'cancelled', by: stopper?.display_name ?? 'someone' });
      return reply.send({ run_id: run.id, state: 'cancelled' });
    });

    app.put<{ Params: { id: string }; Body: { actor_ids?: unknown } }>(
      '/agents/:id/maintainers', async (req, reply) => {
        const me = await who(req.headers.authorization);
        if (!me) return reply.code(401).send({ error: 'unauthenticated' });
        try {
          const actorIds = ids(req.body?.actor_ids);
          if (actorIds === undefined) throw new AgentInvalidError('actor_ids', 'not_a_list');
          const maintainers = await setMaintainers(deps.db, { agentId: req.params.id, by: me.actorId, actorIds });
          return reply.send({ agent_id: req.params.id, maintainers });
        } catch (err) { return refuse(reply, err); }
      });
  };
}
