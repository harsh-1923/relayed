// The six named checkpoints a run passes through (docs/WORKSPACE-AGENTS.md
// §5.9). Each returns a CLOSED result type, and a feature is added by widening
// a result — never by adding a call site somewhere else. That is the same
// discipline `can()` already holds for authorization (`AUTHZ.md` §7): one
// function per question, so two callers cannot quietly disagree about the
// answer.
//
// Each is small in v1 ON PURPOSE. The right-hand column of §5.9's table is
// where a real feature request lands; growing a checkpoint's v1 body to
// "just handle it here" is how the seam stops being one.
import type { Kysely, Transaction } from 'kysely';
import { can, chat as chatTarget } from '@relayed/authz';
import type { DB } from '../db/schema.ts';
import { loadGrants } from '../authz/can.ts';
import { chatPlacement } from '../sync/placement.ts';
import { mentionedActorIds } from '../sync/mentions.ts';

// ─── invocationsFor ─────────────────────────────────────────────────────────

export interface Invocation {
  agentActorId: string;
}

export interface TriggerMessage {
  chatId: string;
  authorId: string;
  body: string;
}

/**
 * Which agents a message starts, if any (§5.1).
 *
 * Called INSIDE `send`'s transaction, for a person's `chat` message only — the
 * caller has already checked the author is a person and the op is `send`
 * (§5.1's other two conditions; an import or an edit must never reach here).
 *
 * A mention is the canonical actor link `mentions.ts` also counts unread
 * badges with — one parser, so a badge and a run cannot disagree about what a
 * mention is (the plan's D6). An agent qualifies only if it is `active` and a
 * member of the space with access to the chat: the same `can()` question any
 * actor's read access is answered with, because an agent's membership works
 * exactly like a person's (`AUTHZ.md` §7).
 *
 * DMs are not built yet (D2) — "every message in a DM with an agent" (§5.1)
 * has no chats to apply to, and is left for whichever step builds `createDm`.
 */
export async function invocationsFor(
  trx: Transaction<DB>, message: TriggerMessage,
): Promise<Invocation[]> {
  const mentioned = mentionedActorIds(message.body);
  if (mentioned.length === 0) return [];

  const agents = await trx.selectFrom('actors')
    .select('id')
    .where('id', 'in', mentioned)
    .where('type', '=', 'agent')
    .where('state', '=', 'active')
    .execute();
  if (agents.length === 0) return [];

  const placement = await chatPlacement(trx, message.chatId);
  const out: Invocation[] = [];
  for (const agent of agents) {
    const grants = await loadGrants(trx, agent.id);
    if (can(grants, 'read', chatTarget(message.chatId), placement)) {
      out.push({ agentActorId: agent.id });
    }
  }
  return out;
}

// ─── admitRun ───────────────────────────────────────────────────────────────

/** Why a claimed run does not start at all — written to `agent_runs.refusal`. */
export type RefusalCode = 'invoker_inactive' | 'agent_inactive' | 'not_a_member' | 'trigger_deleted';

/** Why a run stays queued a little longer — written to `agent_runs.defer_reason`. */
export type DeferReason = 'invoker_busy' | 'runtime_busy';

export type AdmitDecision =
  | { kind: 'admit' }
  | { kind: 'defer'; reason: DeferReason; until: Date }
  | { kind: 'refuse'; code: RefusalCode };

export interface ClaimedRun {
  id: string;
  agentActorId: string;
  invokerActorId: string;
  chatId: string;
  triggerMessageId: string;
}

/** How long an invoker's own runs may occupy the queue at once (§5.3). */
const MAX_RUNS_PER_INVOKER = 3;

/**
 * Execution-time checks, at claim — never at compose time (`DESIGN.md` §6.4):
 * a mention that was valid when it was sent can be stale by the time a run
 * actually starts, and only the state at THAT moment may decide.
 */
export async function admitRun(db: Kysely<DB>, run: ClaimedRun): Promise<AdmitDecision> {
  const [invoker, agent, trigger] = await Promise.all([
    db.selectFrom('actors').select('state').where('id', '=', run.invokerActorId).executeTakeFirst(),
    db.selectFrom('actors').select('state').where('id', '=', run.agentActorId).executeTakeFirst(),
    db.selectFrom('messages').select('deleted').where('id', '=', run.triggerMessageId).executeTakeFirst(),
  ]);

  if (!invoker || invoker.state !== 'active') return { kind: 'refuse', code: 'invoker_inactive' };
  if (!agent || agent.state !== 'active') return { kind: 'refuse', code: 'agent_inactive' };
  if (!trigger || trigger.deleted) return { kind: 'refuse', code: 'trigger_deleted' };

  const placement = await chatPlacement(db, run.chatId);
  const [invokerGrants, agentGrants] = await Promise.all([
    loadGrants(db, run.invokerActorId), loadGrants(db, run.agentActorId),
  ]);
  if (!can(invokerGrants, 'read', chatTarget(run.chatId), placement)) {
    return { kind: 'refuse', code: 'invoker_inactive' };
  }
  if (!can(agentGrants, 'read', chatTarget(run.chatId), placement)) {
    return { kind: 'refuse', code: 'not_a_member' };
  }

  const busy = await db.selectFrom('agent_runs').select(db.fn.countAll<number>().as('n'))
    .where('invoker_actor_id', '=', run.invokerActorId)
    .where('state', '=', 'running')
    .executeTakeFirstOrThrow();
  // One person cannot take the whole runtime's capacity. `+5s`: retried soon,
  // not spun on — the same interval the dispatcher's own poll runs at.
  if (Number(busy.n) >= MAX_RUNS_PER_INVOKER) {
    return { kind: 'defer', reason: 'invoker_busy', until: new Date(Date.now() + 5_000) };
  }

  return { kind: 'admit' };
}

// ─── beforeToolCall / afterToolCall ─────────────────────────────────────────
//
// The broker (step 5) calls these at steps 4–8 and step 10 of §5.5. Nothing
// calls them yet, and the v1 body is what §5.9's table says it must be until
// then: every tool call stops, because there is no connection, no permission
// and no session for it to run against.

export type ToolCallDecision =
  | { kind: 'execute' }
  | { kind: 'stop'; code: 'tool_not_allowed'; card?: never };

/** v1: nothing is allowed. Step 5 replaces this with §5.5 steps 4–8. */
export function beforeToolCall(): ToolCallDecision {
  return { kind: 'stop', code: 'tool_not_allowed' };
}

/** v1: nothing to record — no call reaches here yet. Step 5 fills this in. */
export function afterToolCall(): void { /* nothing in v1 */ }

// ─── deliverReply ───────────────────────────────────────────────────────────

export type DeliveryDecision =
  | { kind: 'post' }
  | { kind: 'suppress' };

/**
 * Whether a finished run's reply is posted, re-read inside the transaction
 * that would write it (§5.8: stop wins over an answer landing at the same
 * moment). `state` is the row as THIS transaction sees it, not as it was when
 * the runtime called back — the whole reason for the re-read.
 *
 * `queued` posts too: a run stopped before it was ever claimed, or while
 * deferred (both leave the row `queued`), still owes the "Stopped by X"
 * notice (§5.8, "a queued or deferred run is cancelled without the runtime
 * ever hearing of it") — nothing else ever calls this on a queued row, since
 * the runtime's own `done` can only arrive for one already claimed.
 */
export function deliverReply(state: string): DeliveryDecision {
  return state === 'running' || state === 'queued' ? { kind: 'post' } : { kind: 'suppress' };
}

// ─── onRunEnd ───────────────────────────────────────────────────────────────

/** v1: the caller posts a notice and ends the activity push itself (§5.7). This exists as the named seam for what runs after. */
export function onRunEnd(): void { /* nothing beyond what reply.ts already does in v1 */ }
