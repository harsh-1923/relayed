// Re-running a request once the access it waited on is given
// (docs/WORKSPACE-AGENTS-IMPL.md, step 7, D25). Nothing is paused while a card
// is open — the person may connect hours later — so a resolved card starts the
// same request again as the next attempt, instead of asking them to.
//
// Its own module because both `access.ts` (a card resolving) and
// `checkpoints.ts` (a run ending) call it, and neither may import the other's
// dependencies without a cycle through `dispatcher.ts`.
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { ulid } from '../db/ulid.ts';

/**
 * Queue attempt + 1 of this run, if and only if: the run has finished, it raised
 * at least one card, every one of its cards is resolved or expired, and at least
 * one was resolved. Returns the new run's id, or null when nothing was queued.
 *
 * Called from both sides of the race — a card resolving while its run is still
 * writing "I need access", and that run ending — so whichever comes second does
 * the work. Two callers arriving together cannot queue two re-runs:
 * `UNIQUE (trigger_message_id, agent_actor_id, attempt)` refuses the second, and
 * `ON CONFLICT DO NOTHING` makes that a no-op rather than an error.
 */
export async function rerunIfReady(db: Kysely<DB>, runId: string): Promise<string | null> {
  const run = await db.selectFrom('agent_runs')
    .select(['workspace_id', 'agent_actor_id', 'invoker_actor_id', 'chat_id', 'trigger_message_id', 'attempt', 'chain_depth', 'state'])
    .where('id', '=', runId).executeTakeFirst();
  if (!run || run.state === 'queued' || run.state === 'running') return null;

  const cards = await db.selectFrom('access_requests').select(['resolved_at', 'expired_at'])
    .where('run_id', '=', runId).execute();
  if (cards.length === 0) return null;
  if (cards.some(card => !card.resolved_at && !card.expired_at)) return null;
  if (!cards.some(card => card.resolved_at)) return null;

  const inserted = await db.insertInto('agent_runs').values({
    id: ulid('run'), workspace_id: run.workspace_id, agent_actor_id: run.agent_actor_id,
    invoker_actor_id: run.invoker_actor_id, chat_id: run.chat_id, trigger_message_id: run.trigger_message_id,
    attempt: run.attempt + 1, chain_depth: run.chain_depth, state: 'queued',
  })
    .onConflict(oc => oc.columns(['trigger_message_id', 'agent_actor_id', 'attempt']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted?.id ?? null;
}
