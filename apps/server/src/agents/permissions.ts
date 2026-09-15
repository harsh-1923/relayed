// Which agents may spend a person's connections, and at what effect
// (docs/WORKSPACE-AGENTS.md §6.4; the plan's step 4).
//
// A connection says Alice has a Linear account here. This says which agent
// she has let use it — kept apart from `connections` on purpose (§6.4's
// table): Composio has no notion of an agent, so nothing here rides through
// it. Enforcing it is step 5's broker; this is only the write side.
//
// Both routes are for the session's OWN actor only: `invoker_actor_id` is
// always the caller, never a body field — the same discipline `connections.ts`
// uses for `actor_id`. Alice can grant or revoke only her own row; she cannot
// touch Bob's, and nothing here lets her.
//
// The grant itself — computing the effect, upserting the row, pushing it —
// lives in `access.ts`'s `grantPermission`: this route is a thin wrapper over
// it, the same operation the access card's own Allow reaches.
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { caller as bearerCaller, type Caller } from '../auth/caller.ts';
import { Forbidden } from '../authz/can.ts';
import { requireAgent, AgentNotFoundError, AgentDeactivatedError } from './definitions.ts';
import { resolveAccessRequests, grantPermission, rerunResolved, type Effect } from './access.ts';
import { pushToActor } from '../sync/fanout.ts';
import type { Registry } from '../sync/registry.ts';

export interface PermissionRouteDeps {
  db: Kysely<DB>;
  deliver: Parameters<typeof resolveAccessRequests>[1];
  registry: Registry;
  /** Nudges the dispatcher after a grant re-runs a waiting request. Absent when the dispatcher never started. */
  dispatcher?: { wake(): void };
  /** Injected so a test needs no signing key; production reads the bearer token. */
  caller?: (authorization: string | undefined) => Promise<Caller | null>;
}

export function permissionRoutes(deps: PermissionRouteDeps) {
  const who = deps.caller ?? bearerCaller;

  return async function register(app: FastifyInstance): Promise<void> {
    app.put<{ Params: { agentId: string; toolkit: string } }>(
      '/agent-permissions/:agentId/:toolkit', async (req, reply) => {
        const me = await who(req.headers.authorization);
        if (!me) return reply.code(401).send({ error: 'unauthenticated' });

        try {
          const agent = await requireAgent(deps.db, me.actorId, req.params.agentId, 'read_definition');
          if (agent.state === 'deactivated') throw new AgentDeactivatedError(req.params.agentId);
        } catch (err) {
          if (err instanceof AgentNotFoundError) return reply.code(404).send({ error: 'not_found' });
          if (err instanceof AgentDeactivatedError) return reply.code(409).send({ error: 'agent_deactivated' });
          if (err instanceof Forbidden) return reply.code(403).send({ error: 'forbidden', action: err.action });
          throw err;
        }

        const toolkit = await deps.db.selectFrom('toolkits').select('slug')
          .where('slug', '=', req.params.toolkit).where('enabled', '=', true).executeTakeFirst();
        if (!toolkit) return reply.code(404).send({ error: 'toolkit_not_found' });

        const granted = await grantPermission(deps.db, deps.registry, {
          invokerActorId: me.actorId, agentActorId: req.params.agentId, toolkit: req.params.toolkit,
          workspaceId: me.workspaceId,
        });

        // "A permission granted from the connector store instead of the card
        // resolves every open card... the same way" (§7.4) — this grant and
        // the card's own Allow are the same operation, so both close it, and
        // both re-run what was waiting on it.
        const runIds = await resolveAccessRequests(deps.db, deps.deliver, {
          actorId: me.actorId, agentActorId: req.params.agentId, toolkit: req.params.toolkit, effect: granted.effect,
        });
        await rerunResolved(deps.db, runIds, deps.dispatcher);
        return reply.send({ agent_id: req.params.agentId, toolkit: req.params.toolkit, effect: granted.effect });
      });

    /** Revoke: only THIS agent loses it (§6.4) — the connection, and every other agent's permission, are untouched. */
    app.delete<{ Params: { agentId: string; toolkit: string } }>(
      '/agent-permissions/:agentId/:toolkit', async (req, reply) => {
        const me = await who(req.headers.authorization);
        if (!me) return reply.code(401).send({ error: 'unauthenticated' });

        const row = await deps.db.selectFrom('agent_permissions').select(['revoked_at', 'effect'])
          .where('invoker_actor_id', '=', me.actorId).where('agent_actor_id', '=', req.params.agentId)
          .where('toolkit', '=', req.params.toolkit).executeTakeFirst();
        if (!row) return reply.code(404).send({ error: 'not_found' });

        if (!row.revoked_at) {
          // A row is REVOKED, never deleted (013_connections.sql): reconnecting
          // later must not ask the person to re-allow an agent they already did.
          await deps.db.updateTable('agent_permissions').set({ revoked_at: sql`now()` })
            .where('invoker_actor_id', '=', me.actorId).where('agent_actor_id', '=', req.params.agentId)
            .where('toolkit', '=', req.params.toolkit).execute();
          pushToActor(deps.registry, me.actorId, me.workspaceId, 'agent_permissions', {
            rows: [{ agent_actor_id: req.params.agentId, toolkit: req.params.toolkit,
                     effect: row.effect as Effect, revoked: true }],
          });
        }
        return reply.send({ agent_id: req.params.agentId, toolkit: req.params.toolkit, revoked: true });
      });
  };
}
