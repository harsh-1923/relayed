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
import { sql, type Kysely, type Transaction } from 'kysely';
import { can, chat as chatTarget } from '@relayed/authz';
import { count } from '@relayed/telemetry';
import type { DB } from '../db/schema.ts';
import { loadGrants } from '../authz/can.ts';
import { chatPlacement } from '../sync/placement.ts';
import { mentionedActorIds } from '../sync/mentions.ts';
import { rerunIfReady } from './rerun.ts';
import { ulid } from '../db/ulid.ts';

// ─── startMentionedRuns ──────────────────────────────────────────────────────

/** A chain stops here: a run this deep starts no runs from its messages. */
export const MAX_CHAIN_DEPTH = 3;

/**
 * THE HANDOFF (§5.2): queue a run for every agent a just-written message
 * mentions, inside the transaction that wrote it. The one place a run is
 * started from a message, whoever wrote it.
 *
 * A person's message starts runs at depth 1, for that person. A message an
 * agent writes during a run — its reply, or one it posts — starts the agents it
 * mentions at that run's depth + 1, **for the same person**: the chained run's
 * invoker is the original person, so it spends their permissions and
 * connections, never the agent's (an agent has none). Past `MAX_CHAIN_DEPTH`
 * nothing is started, which is what stops two agents mentioning each other
 * from running for ever.
 */
export async function startMentionedRuns(
  trx: Transaction<DB>,
  input: { chatId: string; messageId: string; authorId: string; body: string; invokerActorId: string; depth: number },
): Promise<string[]> {
  if (input.depth > MAX_CHAIN_DEPTH) return [];
  const invocations = await invocationsFor(trx, { chatId: input.chatId, authorId: input.authorId, body: input.body });
  if (invocations.length === 0) return [];
  // A run reads only what its agent AND its person can both read (§5.6), and
  // `admitRun` refuses one whose person cannot read the chat. So an agent's
  // message in a place the original person is not — a DM between the agent and
  // Bob — starts nobody, rather than a run that would only post a refusal there.
  if (input.invokerActorId !== input.authorId) {
    const grants = await loadGrants(trx, input.invokerActorId);
    if (!can(grants, 'read', chatTarget(input.chatId), await chatPlacement(trx, input.chatId))) return [];
  }
  const chat = await trx.selectFrom('chats').select('workspace_id')
    .where('id', '=', input.chatId).executeTakeFirstOrThrow();
  const rows = invocations.map(invocation => ({
    id: ulid('run'), workspace_id: chat.workspace_id, agent_actor_id: invocation.agentActorId,
    invoker_actor_id: input.invokerActorId, chat_id: input.chatId, trigger_message_id: input.messageId,
    chain_depth: input.depth, state: 'queued' as const,
  }));
  await trx.insertInto('agent_runs').values(rows).execute();
  return rows.map(row => row.id);
}

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
 * Called through `startMentionedRuns`, INSIDE the transaction that wrote the
 * message — a person's send, or a message an agent wrote during a run (its
 * reply, or one it posted). An import or an edit must never reach here.
 *
 * A mention is the canonical actor link `mentions.ts` also counts unread
 * badges with — one parser, so a badge and a run cannot disagree about what a
 * mention is (the plan's D6). An agent qualifies only if it is `active` and a
 * member of the space with access to the chat: the same `can()` question any
 * actor's read access is answered with, because an agent's membership works
 * exactly like a person's (`AUTHZ.md` §7).
 *
 * A DM with an agent is no different: it runs when mentioned, not on every
 * message (§5.1's "every message in a DM with an agent" is not built).
 */
export async function invocationsFor(
  trx: Transaction<DB>, message: TriggerMessage,
): Promise<Invocation[]> {
  const mentioned = mentionedActorIds(message.body);
  if (mentioned.length === 0) return [];

  // Never the author itself: an agent mentioning itself in its own message
  // would only start itself again.
  const agents = await trx.selectFrom('actors')
    .select('id')
    .where('id', 'in', mentioned)
    .where('id', '!=', message.authorId)
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

/**
 * Why a run stays queued a little longer — written to `agent_runs.defer_reason`.
 *
 * No `invoker_busy`: a person's runs already in flight never hold back their
 * next mention. The cap it enforced counted a run left `running` by a server
 * restart until its lease expired — ten minutes in which every new mention from
 * that person queued behind requests nobody was working on.
 */
export type DeferReason = 'runtime_busy';

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

  return { kind: 'admit' };
}

// ─── beforeToolCall / afterToolCall ─────────────────────────────────────────
//
// The broker (`broker.ts`) calls these at steps 4-8 and step 10 of §5.5.
// `broker.ts` itself owns steps 1-3 (grant, run row, WHO) and step 9
// (execute, through `sessions.ts` and `composio.ts`) — everything about
// WHETHER a call may run, and everything about RECORDING what happened to
// it, lives here instead, the same seam-by-question discipline `can()` holds.

export type Effect = 'read' | 'write' | 'destructive';

export type ToolCallDecision =
  | { kind: 'execute'; connectionId: string; toolkit: string; effect: Effect }
  | { kind: 'stop'; code: 'invoker_inactive' | 'agent_inactive' | 'tool_not_allowed' | 'tool_deprecated' | 'duplicate_call' }
  /** The two codes an access card can be raised for (§7.4) — carries what raising one needs, so `broker.ts` never re-derives it. */
  | { kind: 'stop'; code: 'permission_required' | 'connection_required'; toolkit: string; effect: Effect };

export interface ToolCallInput {
  runId: string;
  invokerActorId: string;
  agentActorId: string;
  toolCallId: string;
  /** A tool slug as the MODEL named it — resolved against our catalogue here, never trusted (step 7). */
  tool: string;
  arguments: unknown;
}

const EFFECT_RANK = { read: 0, write: 1, destructive: 2 } as const;

/** The unique index lost a race the claim itself won: the same tool_call_id twice. */
const isDuplicateCall = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';

/** 8 KB, like a refresh token's hash-not-value discipline: kept for the audit, never at the cost of the row it describes. */
export function argumentsForAudit(args: unknown): unknown {
  const json = JSON.stringify(args ?? {});
  return Buffer.byteLength(json, 'utf8') <= 8192 ? args : { truncated: true, bytes: Buffer.byteLength(json, 'utf8') };
}

export type AccessDecision =
  | { kind: 'ok'; connectionId: string }
  | { kind: 'stop'; code: 'permission_required' | 'connection_required' };

/**
 * Steps 7 and 8 of §5.5 — may THIS agent spend THIS person's account in this
 * toolkit at this effect. One function, asked both before a search
 * (`find_tools`) and before every call, so the two can never disagree about
 * who has access. Permission first: an agent never allowed learns nothing
 * about whether the person is connected (§7.4's public wording rule).
 */
export async function checkAccess(
  db: Kysely<DB>, input: { invokerActorId: string; agentActorId: string; toolkit: string; effect: Effect },
): Promise<AccessDecision> {
  const permission = await db.selectFrom('agent_permissions').select('effect')
    .where('invoker_actor_id', '=', input.invokerActorId).where('agent_actor_id', '=', input.agentActorId)
    .where('toolkit', '=', input.toolkit).where('revoked_at', 'is', null).executeTakeFirst();
  if (!permission || EFFECT_RANK[permission.effect] < EFFECT_RANK[input.effect]) {
    return { kind: 'stop', code: 'permission_required' };
  }
  const connection = await db.selectFrom('connections').select(['id', 'composio_account_id'])
    .where('actor_id', '=', input.invokerActorId).where('toolkit', '=', input.toolkit)
    .where('status', '=', 'active').executeTakeFirst();
  if (!connection || !connection.composio_account_id) return { kind: 'stop', code: 'connection_required' };
  return { kind: 'ok', connectionId: connection.id };
}

/**
 * Steps 4-8 of §5.5, in order. A call that stops at 7 or 8 is claimed first
 * (step 6) and its outcome recorded before returning — "claiming first also
 * means a call that stopped at a missing permission or connection is in the
 * audit trail too."
 */
export async function beforeToolCall(db: Kysely<DB>, input: ToolCallInput): Promise<ToolCallDecision> {
  // step 4: still allowed?
  const [invoker, agent] = await Promise.all([
    db.selectFrom('actors').select('state').where('id', '=', input.invokerActorId).executeTakeFirst(),
    db.selectFrom('actors').select('state').where('id', '=', input.agentActorId).executeTakeFirst(),
  ]);
  if (!invoker || invoker.state !== 'active') return { kind: 'stop', code: 'invoker_inactive' };
  if (!agent || agent.state !== 'active') return { kind: 'stop', code: 'agent_inactive' };

  // step 5: a real tool, in a toolkit this deployment offers. The effect is the
  // catalogue's, never anything the model said (the plan's step 7).
  const known = await db.selectFrom('toolkit_tools')
    .innerJoin('toolkits', 'toolkits.slug', 'toolkit_tools.toolkit')
    .select(['toolkit_tools.toolkit as toolkit', 'toolkit_tools.slug as tool', 'toolkit_tools.deprecated as deprecated',
             'toolkit_tools.effect_derived as effect_derived', 'toolkit_tools.effect_override as effect_override'])
    .where('toolkit_tools.slug', '=', input.tool).where('toolkits.enabled', '=', true)
    .executeTakeFirst();
  if (!known) return { kind: 'stop', code: 'tool_not_allowed' };
  if (known.deprecated) return { kind: 'stop', code: 'tool_deprecated' };
  const effect: Effect = known.effect_override ?? known.effect_derived;

  // step 6: claim the call — one row, ever, per (run, tool_call_id).
  try {
    await db.insertInto('agent_tool_calls').values({
      run_id: input.runId, tool_call_id: input.toolCallId, toolkit: known.toolkit,
      tool: known.tool, effect, outcome: 'pending',
      arguments: sql`${JSON.stringify(argumentsForAudit(input.arguments))}::jsonb`,
    }).execute();
  } catch (err) {
    if (isDuplicateCall(err)) return { kind: 'stop', code: 'duplicate_call' };
    throw err;
  }

  // steps 7 and 8: permission, then connection.
  const access = await checkAccess(db, {
    invokerActorId: input.invokerActorId, agentActorId: input.agentActorId, toolkit: known.toolkit, effect,
  });
  if (access.kind === 'stop') {
    await afterToolCall(db, {
      runId: input.runId, toolCallId: input.toolCallId, effect, outcome: access.code, durationMs: 0,
    });
    return { kind: 'stop', code: access.code, toolkit: known.toolkit, effect };
  }
  return { kind: 'execute', connectionId: access.connectionId, toolkit: known.toolkit, effect };
}

export interface ToolCallResult {
  runId: string;
  toolCallId: string;
  effect: 'read' | 'write' | 'destructive';
  outcome: 'ok' | 'duplicate_call' | 'permission_required' | 'connection_required'
    | 'needs_reauth' | 'failed' | 'refused' | 'tool_deprecated' | 'rate_limited'
    | 'provider_forbidden' | 'provider_unavailable';
  errorCode?: string | null;
  durationMs: number;
  connectionId?: string | null;
}

/**
 * Step 10: record. Every outcome from step 6 on lands here — `beforeToolCall`
 * calls it for its own two early stops, `broker.ts` calls it once more after
 * step 9 actually runs (or fails to). `duplicate_call` never reaches this:
 * the claim that would have recorded it never happened.
 */
export async function afterToolCall(db: Kysely<DB>, result: ToolCallResult): Promise<void> {
  await db.updateTable('agent_tool_calls').set({
    outcome: result.outcome, error_code: result.errorCode ?? null, duration_ms: result.durationMs,
    ...(result.connectionId ? { connection_id: result.connectionId } : {}),
  }).where('run_id', '=', result.runId).where('tool_call_id', '=', result.toolCallId).execute();
  count('agent.tool', { tool_effect: result.effect, tool_outcome: result.outcome });
}

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

/**
 * After a run's terminal message is written. The reply and the activity push
 * are the caller's (§5.7); what runs here is what follows a run. In step 7 that
 * is one thing: a card resolved while this run was still finishing re-runs it
 * now (`rerun.ts`, D25). The dispatcher's next poll claims it.
 */
export async function onRunEnd(db: Kysely<DB>, runId: string): Promise<void> {
  await rerunIfReady(db, runId);
}
