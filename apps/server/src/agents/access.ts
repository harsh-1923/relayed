// The card a missing connection or permission raises in a chat
// (docs/WORKSPACE-AGENTS.md §7.4), and the two ways it closes: Allow, from
// the card itself, or a grant from the connector store instead. Both close
// through the SAME `grantPermission` — one place the effect is computed, the
// row is upserted, and the push goes out — so `permissions.ts`'s `PUT` route
// is a thin wrapper over this file rather than a second copy of the logic.
//
// One card kind covers a missing connection, a missing permission, and one
// that needs reauthorising: which applies is read from the ACTOR's own
// `connections`/`agent_permissions` at render time, never encoded here. This
// file only ever writes `pending` or `resolved` — expiry (leaving the room,
// deactivation, or simply age) is not wired to anything yet; nothing sets
// `expired_at` today. `access_requests.created_at` is when a card was raised,
// which is all a later age-based expiry needs.
//
// A resolved card re-runs the request it interrupted (`rerun.ts`, the plan's
// D25): nothing waits while a card is open.
import { sql, type Kysely } from 'kysely';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DB } from '../db/schema.ts';
import { ulid } from '../db/ulid.ts';
import { caller as bearerCaller, type Caller } from '../auth/caller.ts';
import { writeMessage, updateMessage } from '../sync/ops.ts';
import type { AppendedEvent } from '../sync/events.ts';
import type { FanoutResult } from '../sync/fanout.ts';
import { pushToActor } from '../sync/fanout.ts';
import type { Registry } from '../sync/registry.ts';
import { triggerRef } from './dispatcher.ts';
import { replyParentOf } from './transcript.ts';
import { rerunIfReady } from './rerun.ts';

const EFFECT_RANK = { read: 0, write: 1, destructive: 2 } as const;
export type Effect = keyof typeof EFFECT_RANK;

export interface AccessRouteDeps {
  db: Kysely<DB>;
  deliver: (event: AppendedEvent) => Promise<FanoutResult>;
  registry: Registry;
  /** Nudges the dispatcher after a resolved card queues a re-run. Absent when the dispatcher never started (D5). */
  dispatcher?: { wake(): void };
  caller?: (authorization: string | undefined) => Promise<Caller | null>;
}

/**
 * Grant this agent the person's account in one toolkit, and push the row. The
 * one place this happens: `permissions.ts`'s `PUT` and this file's own
 * `/allow` both call it.
 *
 * Up to `write`, or `destructive` when the card being allowed was raised by a
 * destructive call (the plan's D23) — never a client-chosen effect, and never
 * lower than a grant the person already made: allowing an ordinary card must
 * not quietly take back a destructive one.
 */
export async function grantPermission(
  db: Kysely<DB>, registry: Registry,
  input: { invokerActorId: string; agentActorId: string; toolkit: string; workspaceId: string; effect?: Effect },
): Promise<{ effect: Effect }> {
  const wanted: Effect = input.effect === 'destructive' ? 'destructive' : 'write';
  const held = await db.selectFrom('agent_permissions').select(['effect', 'revoked_at'])
    .where('invoker_actor_id', '=', input.invokerActorId).where('agent_actor_id', '=', input.agentActorId)
    .where('toolkit', '=', input.toolkit).executeTakeFirst();
  const effect: Effect = held && !held.revoked_at && EFFECT_RANK[held.effect] > EFFECT_RANK[wanted]
    ? held.effect : wanted;

  await db.insertInto('agent_permissions').values({
    invoker_actor_id: input.invokerActorId, agent_actor_id: input.agentActorId, toolkit: input.toolkit, effect,
  })
    .onConflict(oc => oc.columns(['invoker_actor_id', 'agent_actor_id', 'toolkit']).doUpdateSet({
      effect, revoked_at: null, granted_at: sql`now()`,
    }))
    .execute();

  pushToActor(registry, input.invokerActorId, input.workspaceId, 'agent_permissions', {
    rows: [{ agent_actor_id: input.agentActorId, toolkit: input.toolkit, effect, revoked: false }],
  });
  return { effect };
}

async function names(db: Kysely<DB>, actorId: string, agentActorId: string, toolkit: string) {
  const [actor, agent, tk] = await Promise.all([
    db.selectFrom('actors').select('display_name').where('id', '=', actorId).executeTakeFirst(),
    db.selectFrom('actors').select('handle').where('id', '=', agentActorId).executeTakeFirst(),
    db.selectFrom('toolkits').select('name').where('slug', '=', toolkit).executeTakeFirst(),
  ]);
  return {
    actorName: actor?.display_name ?? 'someone',
    agentHandle: agent?.handle ?? 'agent',
    toolkitName: tk?.name ?? toolkit,
  };
}

/**
 * Raise the card for one (run, toolkit) — once. Called from `broker.ts` when
 * `beforeToolCall` stops at `permission_required` or `connection_required`.
 * A second tool call in the same run hitting the same block must not spam a
 * second card: the `UNIQUE (run_id, toolkit)` index is the backstop, this
 * check is what avoids paying for the write at all.
 */
export async function raiseAccessRequest(
  db: Kysely<DB>, deliver: (event: AppendedEvent) => Promise<FanoutResult>,
  input: { runId: string; invokerActorId: string; agentActorId: string; toolkit: string; effect: Effect },
): Promise<void> {
  const existing = await db.selectFrom('access_requests').select('id')
    .where('run_id', '=', input.runId).where('toolkit', '=', input.toolkit).executeTakeFirst();
  if (existing) return;

  const run = await db.selectFrom('agent_runs').select(['chat_id', 'trigger_message_id'])
    .where('id', '=', input.runId).executeTakeFirst();
  if (!run) return;
  const trigger = await triggerRef(db, run.trigger_message_id, run.chat_id);
  const replyParentId = replyParentOf(trigger, run.trigger_message_id);
  // Its OWN id, never the run's reply id: the model still answers after a
  // card ("I need access to your GitHub"), and that answer is written under
  // the reply id — sharing it collided on messages_pkey and left the run stuck.
  const cardMessageId = ulid('msg');
  const { actorName, agentHandle, toolkitName } = await names(db, input.invokerActorId, input.agentActorId, input.toolkit);

  const requestId = ulid('arq');
  let event: AppendedEvent | undefined;
  await db.transaction().execute(async (trx) => {
    // The message row first: `access_requests.message_id` is a real foreign
    // key, checked per-statement (not deferred), so it must already exist.
    const written = await writeMessage(trx, {
      kind: 'actor', chatId: run.chat_id, messageId: cardMessageId, authorId: input.agentActorId,
      parentId: replyParentId, audience: { kind: 'stream' },
      onBehalfOfActorId: input.invokerActorId, delegationId: input.runId,
      trustedBody: `@${agentHandle} is waiting for [${actorName}](actor:${input.invokerActorId}) `
        + `to give it access to ${toolkitName}.`,
      trustedParts: [{
        kind: 'access_request', request_id: requestId, run_id: input.runId,
        actor_id: input.invokerActorId, agent_id: input.agentActorId,
        toolkit: input.toolkit, effect: input.effect, state: 'pending',
      }],
    });
    event = written.event;

    await trx.insertInto('access_requests').values({
      id: requestId, run_id: input.runId, actor_id: input.invokerActorId, agent_actor_id: input.agentActorId,
      toolkit: input.toolkit, effect: input.effect, message_id: cardMessageId,
    }).execute();
  });
  if (event) await deliver(event);
}

/**
 * Resolve every open card for this (actor, agent, toolkit) that the grant now
 * covers — "a permission granted from the connector store instead of the card
 * resolves every open card... the same way" (§7.4). A destructive card stays
 * open after an ordinary Allow: `write` does not cover it.
 *
 * Returns the runs whose cards it resolved, so the caller can re-run them.
 */
export async function resolveAccessRequests(
  db: Kysely<DB>, deliver: (event: AppendedEvent) => Promise<FanoutResult>,
  input: { actorId: string; agentActorId: string; toolkit: string; effect: Effect },
): Promise<string[]> {
  const open = (await db.selectFrom('access_requests').select(['id', 'message_id', 'run_id', 'effect'])
    .where('actor_id', '=', input.actorId).where('agent_actor_id', '=', input.agentActorId)
    .where('toolkit', '=', input.toolkit).where('resolved_at', 'is', null).where('expired_at', 'is', null)
    .execute())
    .filter(request => EFFECT_RANK[request.effect as Effect] <= EFFECT_RANK[input.effect]);
  if (open.length === 0) return [];

  const { actorName, agentHandle, toolkitName } = await names(db, input.actorId, input.agentActorId, input.toolkit);
  const events: AppendedEvent[] = [];
  await db.transaction().execute(async (trx) => {
    for (const request of open) {
      await trx.updateTable('access_requests').set({ resolved_at: sql`now()` })
        .where('id', '=', request.id).execute();
      const row = await trx.selectFrom('messages').select('chat_id')
        .where('id', '=', request.message_id).executeTakeFirst();
      if (!row) continue;
      events.push(await updateMessage(trx, {
        chatId: row.chat_id, messageId: request.message_id,
        trustedBody: `[${actorName}](actor:${input.actorId}) gave @${agentHandle} access to ${toolkitName}.`,
        trustedParts: [{
          kind: 'access_request', request_id: request.id, run_id: request.run_id, actor_id: input.actorId,
          agent_id: input.agentActorId, toolkit: input.toolkit,
          effect: request.effect as Effect, state: 'resolved',
        }],
      }));
    }
  });
  for (const event of events) await deliver(event);
  return [...new Set(open.map(request => request.run_id))];
}

/** Re-run each run whose cards are now all resolved (D25), and wake the dispatcher if any was queued. */
export async function rerunResolved(
  db: Kysely<DB>, runIds: readonly string[], dispatcher?: { wake(): void },
): Promise<void> {
  let queued = false;
  for (const runId of runIds) {
    if (await rerunIfReady(db, runId)) queued = true;
  }
  if (queued) dispatcher?.wake();
}

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const unauthenticated = (reply: FastifyReply) => reply.code(401).send({ error: 'unauthenticated' });

export function accessRoutes(deps: AccessRouteDeps) {
  const who = deps.caller ?? bearerCaller;

  return async function register(app: FastifyInstance): Promise<void> {
    /**
     * Only the actor acts (§7.4, invariant 88) — refused unless the session's
     * own actor equals the request's, before anything else is read. Grants
     * exactly as `permissions.ts`'s `PUT` does — this IS that grant, reached
     * from the card instead of the connector store — resolves every open card
     * it covers, and re-runs the requests that were waiting on them (D25).
     */
    app.post<{ Params: { id: string } }>('/access-requests/:id/allow', async (req, reply) => {
      const me = await who(req.headers.authorization);
      if (!me) return unauthenticated(reply);

      const request = await deps.db.selectFrom('access_requests')
        .innerJoin('agent_runs', 'agent_runs.id', 'access_requests.run_id')
        .select(['access_requests.actor_id as actor_id', 'access_requests.agent_actor_id as agent_actor_id',
                 'access_requests.toolkit as toolkit', 'access_requests.effect as effect',
                 'access_requests.resolved_at as resolved_at', 'access_requests.expired_at as expired_at',
                 'agent_runs.workspace_id as workspace_id'])
        .where('access_requests.id', '=', req.params.id).executeTakeFirst();
      if (!request) return notFound(reply);
      if (request.actor_id !== me.actorId) return reply.code(403).send({ error: 'forbidden' });
      if (request.resolved_at || request.expired_at) {
        return reply.send({ request_id: req.params.id, state: request.resolved_at ? 'resolved' : 'expired' });
      }

      const granted = await grantPermission(deps.db, deps.registry, {
        invokerActorId: me.actorId, agentActorId: request.agent_actor_id, toolkit: request.toolkit,
        workspaceId: request.workspace_id, effect: request.effect as Effect,
      });
      const runIds = await resolveAccessRequests(deps.db, deps.deliver, {
        actorId: me.actorId, agentActorId: request.agent_actor_id, toolkit: request.toolkit, effect: granted.effect,
      });
      await rerunResolved(deps.db, runIds, deps.dispatcher);
      return reply.send({ request_id: req.params.id, state: 'resolved', effect: granted.effect });
    });
  };
}
