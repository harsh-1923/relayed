// A tool call, end to end (docs/WORKSPACE-AGENTS.md §5.5). The runtime's
// custom tools post here once per call; this is the only thing on the other
// end of them.
//
// WHAT IS HERE, AND WHAT IS NOT. This file owns the parts every call shares —
// the grant, the run, who the caller really is — and step 9 of `call_tool`,
// which is the one path that spends a person's own account. Every other tool
// lives in `tools/`, one file each, answered through `handleAppTool`.
//
// Steps 1-3 and 9 are here. Steps 4-8 and 10 are `checkpoints.ts`'s
// `beforeToolCall`/`afterToolCall` — everything about whether a call may run,
// and everything about recording what happened, is answered there.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import type { AppendedEvent } from '../sync/events.ts';
import type { FanoutResult } from '../sync/fanout.ts';
import { verifyGrant, GrantError } from './grant.ts';
import { beforeToolCall, afterToolCall } from './checkpoints.ts';
import { ComposioError } from './composio.ts';
import { COMPOSIO, type BrokerComposio } from './composio-broker.ts';
import { mapComposioError, mapExecuteResult } from './tool-errors.ts';
import { raiseAccessRequest } from './access.ts';
import { ROOMKEEPER_HANDLE } from '../provisioning/system-agents.ts';
import { asRecord, handleAppTool, CALL_TOOL, type ToolContext, type Where } from './tools/index.ts';

export type { BrokerComposio } from './composio-broker.ts';

export interface BrokerRouteDeps {
  db: Kysely<DB>;
  deliver: (event: AppendedEvent) => Promise<FanoutResult>;
  composio?: BrokerComposio;
  /** Nudged when a message an agent sends mentions another agent, so that run starts now rather than at the next poll. */
  dispatcher?: { wake(): void };
}

interface ToolCallBody {
  runId?: unknown;
  toolCallId?: unknown;
  tool?: unknown;
  arguments?: unknown;
}

/** The runtime's own tool-output cap (§5.5) — Composio's list endpoints routinely return more than a model context wants. */
const RESULT_CAP_BYTES = 32_768;

function truncatedResult(data: unknown): { data: unknown; truncated: boolean } {
  const json = JSON.stringify(data ?? null);
  if (Buffer.byteLength(json, 'utf8') <= RESULT_CAP_BYTES) return { data, truncated: false };
  return { data: json.slice(0, RESULT_CAP_BYTES), truncated: true };
}

/**
 * Where this run is and who is running it, from OUR rows.
 *
 * Recomputed rather than carried on the call, because it is what decides
 * whether a tool was offered at all — and the offer is the authorisation
 * (`tools/index.ts`). Taken from the request, a model could name a tool it
 * never received and be given it.
 */
async function whereOf(db: Kysely<DB>, chatId: string, agentActorId: string): Promise<Where> {
  const [place, agent] = await Promise.all([
    db.selectFrom('chats').innerJoin('spaces', 'spaces.id', 'chats.space_id')
      .select(['spaces.kind as space_kind', 'chats.kind as chat_kind'])
      .where('chats.id', '=', chatId).executeTakeFirst(),
    db.selectFrom('actors').select(['handle', 'provisioned_by'])
      .where('id', '=', agentActorId).executeTakeFirst(),
  ]);
  return {
    inRoom: place?.space_kind === 'room' && place.chat_kind !== 'private',
    isRoomkeeper: agent?.handle === ROOMKEEPER_HANDLE && agent.provisioned_by === 'system',
  };
}

export function brokerRoutes(deps: BrokerRouteDeps) {
  const composio = deps.composio ?? COMPOSIO;

  return async function register(app: FastifyInstance): Promise<void> {
    app.post<{ Body: ToolCallBody }>('/agent/tools', async (req, reply) => {
      const started = performance.now();
      const authorization = req.headers.authorization ?? '';
      const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      const runId = typeof req.body?.runId === 'string' ? req.body.runId : undefined;
      const toolCallId = typeof req.body?.toolCallId === 'string' ? req.body.toolCallId : undefined;
      const tool = typeof req.body?.tool === 'string' ? req.body.tool : undefined;
      if (!bearer || !runId || !toolCallId || !tool) {
        return reply.code(400).send({ error: 'invalid', reason: 'runId, toolCallId and tool are required' });
      }

      // step 1: verify grant — signature, audience, expiry, and that it names THIS run.
      let grant;
      try {
        grant = await verifyGrant(bearer, runId);
      } catch (err) {
        if (err instanceof GrantError) return reply.code(401).send({ error: 'invalid_grant', reason: err.reason });
        throw err;
      }

      // step 2: load the run — must still be running.
      const run = await deps.db.selectFrom('agent_runs').select(['state', 'chat_id', 'chain_depth'])
        .where('id', '=', runId).executeTakeFirst();
      if (!run || run.state !== 'running') return reply.send({ result: 'run_not_running' });

      // step 3: WHO — from OUR row (the grant's own claims), never the body.
      const invokerActorId = grant.invokerActorId;
      const agentActorId = grant.agentActorId;
      const args = asRecord(req.body?.arguments);
      const context: ToolContext = {
        runId, toolCallId, chatId: run.chat_id, invokerActorId, agentActorId, chainDepth: run.chain_depth,
      };

      // Every tool but `call_tool`, answered by the file that owns it.
      if (tool !== CALL_TOOL) {
        const where = await whereOf(deps.db, run.chat_id, agentActorId);
        const answered = await handleAppTool(tool, {
          db: deps.db, deliver: deps.deliver, composio,
          ...(deps.dispatcher ? { dispatcher: deps.dispatcher } : {}),
        }, context, where, args);
        return reply.send(answered ?? { result: 'tool_not_allowed' });
      }

      const slug = typeof args['tool'] === 'string' ? args['tool'] : '';
      const toolArguments = asRecord(args['arguments']);

      // steps 4-8
      const decision = await beforeToolCall(deps.db, {
        runId, invokerActorId, agentActorId, toolCallId, tool: slug, arguments: toolArguments,
      });
      if (decision.kind === 'stop') {
        if (decision.code === 'permission_required' || decision.code === 'connection_required') {
          await raiseAccessRequest(deps.db, deps.deliver, {
            runId, invokerActorId, agentActorId, toolkit: decision.toolkit, effect: decision.effect,
          });
        }
        return reply.send({ result: decision.code });
      }

      // step 9: execute, through this person's session.
      let outcome;
      try {
        const sessionId = await composio.session(deps.db, invokerActorId);
        outcome = mapExecuteResult(await composio.execute(sessionId, slug, toolArguments));
      } catch (err) {
        if (err instanceof ComposioError) outcome = mapComposioError(err);
        else throw err;
      }

      // step 10: record — every outcome from step 6 on.
      const durationMs = Math.round(performance.now() - started);
      await afterToolCall(deps.db, {
        runId, toolCallId, effect: decision.effect, outcome: outcome.code,
        errorCode: 'message' in outcome ? outcome.code : null,
        durationMs, connectionId: decision.connectionId,
      });

      if (outcome.code === 'ok') {
        const { data, truncated } = truncatedResult(outcome.data);
        return reply.send({ result: 'ok', data, ...(truncated ? { truncated: true } : {}) });
      }
      if (outcome.code === 'refused') {
        // An alert, not a result the model should treat as ordinary (§5.5): our
        // catalogue check and the session disagreeing is a bug in the broker.
        app.log.error({ runId, toolCallId, tool: slug }, 'broker: session refused a tool our catalogue allowed');
      }
      return reply.send({ result: outcome.code, ...('message' in outcome ? { message: outcome.message } : {}) });
    });
  };
}
