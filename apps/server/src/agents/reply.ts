// Writing what a run leaves behind: an answer, or a notice
// (docs/WORKSPACE-AGENTS.md §5.7, §5.8).
//
// Both go through the SAME function, `writeRunMessage`, guarded by the SAME
// ops-ledger key (`op_<runId>`) — which is what makes "exactly one message per
// run" true by construction rather than by three call sites agreeing. An
// answer and a notice can never both land for one run: whichever writer gets
// there first claims the ledger row, and the second is told so and does
// nothing.
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import type { RunResultBody, MessagePart } from '@relayed/protocol';
import { writeMessage, type Ack } from '../sync/ops.ts';
import type { AppendedEvent } from '../sync/events.ts';
import { applyOnce } from '../sync/allocate.ts';
import { deliverReply as deliverReplyDecision, type RefusalCode } from './checkpoints.ts';
import { noticeFor, type FailureReason } from './notices.ts';

export interface FinishedRun {
  id: string;
  chatId: string;
  agentActorId: string;
  invokerActorId: string;
  replyMessageId: string;
  /** The thread the answer belongs in: the trigger's own thread root, or the trigger itself (§5.7). */
  replyParentId: string;
}

export type RunOutcome =
  | { state: 'completed'; result: RunResultBody }
  | { state: 'refused'; code: RefusalCode }
  | { state: 'failed'; reason: FailureReason }
  | { state: 'timeout' }
  | { state: 'interrupted' }
  | { state: 'cancelled'; by: string };

export type WriteOutcome = { posted: true; ack: Ack; event: AppendedEvent } | { posted: false };

/**
 * A remote call's line in the reply: name, outcome and duration — never the
 * arguments or the result (§5.7; those live in the audit trail alone, step 5).
 * `input` is a required field of `ToolPart` upstream, so it is written as
 * `null` deliberately rather than omitted.
 */
function toolPart(call: RunResultBody['toolCalls'][number]): MessagePart {
  return { kind: 'tool', tool_use_id: call.name, name: call.name, ok: call.ok, ms: call.ms, input: null };
}

function answerParts(result: RunResultBody): MessagePart[] {
  const parts: MessagePart[] = [];
  if (result.text.trim().length > 0) parts.push({ kind: 'markdown', text: result.text });
  for (const call of result.toolCalls) parts.push(toolPart(call));
  return parts;
}

/**
 * Write what this run leaves in its thread, and move it to its terminal
 * state — both in ONE transaction, and both guarded by re-reading the row
 * `FOR UPDATE` first (§5.8: stop wins over an answer landing at the same
 * moment). `WHERE state = 'running'` on the update is the second lock on the
 * same door: a run someone stopped a moment before this committed keeps
 * `cancelled` regardless of what this call believed the state was.
 *
 * Idempotent through the ops ledger, on `op_<runId>`: called twice for one
 * run — a bug, a duplicated stream, `/stop` racing `deliverReply` — writes
 * one message and returns the same ack to whichever call loses the race.
 */
type RunState = 'completed' | 'failed' | 'cancelled' | 'timeout' | 'refused' | 'interrupted';

async function writeRunMessage(
  db: Kysely<DB>, run: FinishedRun,
  build: (locked: string) => { body?: string; parts?: MessagePart[]; nextState: RunState; refusal?: string },
): Promise<WriteOutcome> {
  const applied = await applyOnce(db, {
    opId: `op_${run.id}`, actorId: run.agentActorId, chatId: run.chatId, kind: 'send',
  }, async (trx): Promise<WriteOutcome> => {
    const row = await trx.selectFrom('agent_runs').select('state')
      .where('id', '=', run.id)
      .forUpdate()
      .executeTakeFirst();
    const state = row?.state ?? 'cancelled';
    if (deliverReplyDecision(state).kind === 'suppress') return { posted: false };

    const content = build(state);
    const written = await writeMessage(trx, {
      chatId: run.chatId, messageId: run.replyMessageId, authorId: run.agentActorId,
      parentId: run.replyParentId, audience: { kind: 'stream' },
      onBehalfOfActorId: run.invokerActorId, delegationId: run.id,
      ...(content.parts ? { parts: content.parts } : { body: content.body ?? '' }),
    });

    // `IN ('running', 'queued')`, matching `deliverReplyDecision`'s own
    // widened guard above: a run stopped before it was ever claimed is still
    // `queued` at this point, and this is the transition out of it.
    await trx.updateTable('agent_runs')
      .set({ state: content.nextState, refusal: content.refusal ?? null, finished_at: sql`now()` })
      .where('id', '=', run.id).where('state', 'in', ['running', 'queued'])
      .execute();

    return { posted: true, ack: written.ack, event: written.event };
  });
  return applied.result;
}

/** The run's terminal message: the model's answer, or a one-line notice (§5.7). */
export function deliverReply(db: Kysely<DB>, run: FinishedRun, outcome: RunOutcome): Promise<WriteOutcome> {
  if (outcome.state === 'completed') {
    return writeRunMessage(db, run, () => ({ parts: answerParts(outcome.result), nextState: 'completed' }));
  }
  const text = outcome.state === 'refused' ? noticeFor({ state: 'refused', code: outcome.code })
    : outcome.state === 'failed' ? noticeFor({ state: 'failed', reason: outcome.reason })
    : outcome.state === 'timeout' ? noticeFor({ state: 'timeout' })
    : outcome.state === 'interrupted' ? noticeFor({ state: 'interrupted' })
    : noticeFor({ state: 'cancelled', by: outcome.by });
  return writeRunMessage(db, run, () => ({
    body: text, nextState: outcome.state,
    ...(outcome.state === 'refused' ? { refusal: outcome.code } : {}),
  }));
}
