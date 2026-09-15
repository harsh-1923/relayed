// A tool call, end to end (docs/WORKSPACE-AGENTS.md §5.5). The runtime's
// custom tools post here once per call; this is the only thing on the other
// end of them.
//
// A run has two tools (`run-tools.ts`, the plan's step 7): `find_tools`, which
// searches one toolkit and asks for access if the person has not given it, and
// `call_tool`, which runs one tool through the ten steps of §5.5.
//
// Steps 1-3 and 9 live here. Steps 4-8 and 10 are `checkpoints.ts`'s
// `beforeToolCall`/`afterToolCall` — everything about whether a call may run,
// and everything about recording what happened, is answered there.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import type { AppendedEvent } from '../sync/events.ts';
import type { FanoutResult } from '../sync/fanout.ts';
import { verifyGrant, GrantError } from './grant.ts';
import { beforeToolCall, afterToolCall, checkAccess } from './checkpoints.ts';
import { sessionFor } from './sessions.ts';
import {
  executeSessionTool, searchSessionTools, ComposioError, type ExecuteResult, type SearchResult,
} from './composio.ts';
import { mapComposioError, mapExecuteResult } from './tool-errors.ts';
import { raiseAccessRequest } from './access.ts';
import { FIND_TOOLS, CALL_TOOL } from './run-tools.ts';

/** Composio, as the broker uses it — injectable so a test never reaches the network. */
export interface BrokerComposio {
  session(db: Kysely<DB>, invokerActorId: string): Promise<string>;
  search(sessionId: string, useCase: string): Promise<SearchResult>;
  execute(sessionId: string, tool: string, args: Record<string, unknown>): Promise<ExecuteResult>;
}

const COMPOSIO: BrokerComposio = {
  session: sessionFor,
  search: searchSessionTools,
  execute: executeSessionTool,
};

export interface BrokerRouteDeps {
  db: Kysely<DB>;
  deliver: (event: AppendedEvent) => Promise<FanoutResult>;
  composio?: BrokerComposio;
}

interface ToolCallBody {
  runId?: unknown;
  toolCallId?: unknown;
  tool?: unknown;
  arguments?: unknown;
}

/** The runtime's own tool-output cap (§5.5) — Composio's list endpoints routinely return more than a model context wants. */
const RESULT_CAP_BYTES = 32_768;
/** Tools one search hands the model. Composio returns about six; more is context spent on near misses. */
const FOUND_TOOLS_CAP = 8;

function truncatedResult(data: unknown): { data: unknown; truncated: boolean } {
  const json = JSON.stringify(data ?? null);
  if (Buffer.byteLength(json, 'utf8') <= RESULT_CAP_BYTES) return { data, truncated: false };
  return { data: json.slice(0, RESULT_CAP_BYTES), truncated: true };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

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
      const run = await deps.db.selectFrom('agent_runs').select('state')
        .where('id', '=', runId).executeTakeFirst();
      if (!run || run.state !== 'running') return reply.send({ result: 'run_not_running' });

      // step 3: WHO — from OUR row (the grant's own claims), never the body.
      const invokerActorId = grant.invokerActorId;
      const agentActorId = grant.agentActorId;
      const args = asRecord(req.body?.arguments);

      if (tool === FIND_TOOLS) {
        return reply.send(await findTools(deps, composio, { runId, invokerActorId, agentActorId, args }));
      }
      if (tool !== CALL_TOOL) return reply.send({ result: 'tool_not_allowed' });

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

type BrokerReply = { result: string; data?: unknown; message?: string };

/**
 * Search one toolkit for the tools a task needs (step 7).
 *
 * Access is asked for HERE, before the model has planned anything, rather than
 * at its first call: the card arrives as soon as the agent knows which service
 * it needs, and no write can have happened before it. Checked at `read` — the
 * least any tool needs — and asked for at `write`, which is what Allow grants
 * (D23); a destructive tool asks again when it is actually called.
 *
 * What comes back is built here from the search, never the search response
 * itself (D27), and only for tools our catalogue lists in that toolkit: the
 * model is never handed a tool name `call_tool` would then refuse.
 */
async function findTools(
  deps: BrokerRouteDeps, composio: BrokerComposio,
  input: { runId: string; invokerActorId: string; agentActorId: string; args: Record<string, unknown> },
): Promise<BrokerReply> {
  const toolkit = typeof input.args['toolkit'] === 'string' ? input.args['toolkit'] : '';
  const useCase = typeof input.args['use_case'] === 'string' ? input.args['use_case'].trim() : '';
  if (!useCase) return { result: 'failed', message: `${FIND_TOOLS} needs a use_case: what you want to do.` };

  const offered = await deps.db.selectFrom('toolkits').select(['slug', 'name'])
    .where('slug', '=', toolkit).where('enabled', '=', true).executeTakeFirst();
  if (!offered) return { result: 'tool_not_allowed' };

  const [invoker, agent] = await Promise.all([
    deps.db.selectFrom('actors').select('state').where('id', '=', input.invokerActorId).executeTakeFirst(),
    deps.db.selectFrom('actors').select('state').where('id', '=', input.agentActorId).executeTakeFirst(),
  ]);
  if (!invoker || invoker.state !== 'active') return { result: 'invoker_inactive' };
  if (!agent || agent.state !== 'active') return { result: 'agent_inactive' };

  const access = await checkAccess(deps.db, {
    invokerActorId: input.invokerActorId, agentActorId: input.agentActorId, toolkit: offered.slug, effect: 'read',
  });
  if (access.kind === 'stop') {
    await raiseAccessRequest(deps.db, deps.deliver, {
      runId: input.runId, invokerActorId: input.invokerActorId, agentActorId: input.agentActorId,
      toolkit: offered.slug, effect: 'write',
    });
    return { result: access.code };
  }

  let found: SearchResult;
  try {
    const sessionId = await composio.session(deps.db, input.invokerActorId);
    found = await composio.search(sessionId, `${offered.name}: ${useCase}`);
  } catch (err) {
    if (!(err instanceof ComposioError)) throw err;
    const mapped = mapComposioError(err);
    return { result: mapped.code === 'refused' ? 'failed' : mapped.code, ...('message' in mapped ? { message: mapped.message } : {}) };
  }

  const rows = found.toolSlugs.length === 0 ? [] : await deps.db.selectFrom('toolkit_tools')
    .select(['slug', 'description', 'input_schema'])
    .where('toolkit', '=', offered.slug).where('deprecated', '=', false)
    .where('slug', 'in', found.toolSlugs)
    .execute();
  const bySlug = new Map(rows.map(row => [row.slug, row]));
  const tools = found.toolSlugs
    .map(slug => bySlug.get(slug))
    .filter(row => row !== undefined)
    .slice(0, FOUND_TOOLS_CAP)
    .map(row => ({
      name: row.slug,
      description: row.description,
      parameters: found.schemas[row.slug] ?? row.input_schema,
    }));

  if (tools.length === 0) {
    return { result: 'ok', data: { tools: [], note: `No ${offered.name} tool matched. Describe the task differently, or tell the person it cannot be done with ${offered.name}.` } };
  }
  return { result: 'ok', data: { tools } };
}
