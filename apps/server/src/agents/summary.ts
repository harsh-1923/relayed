// What every member's client holds about an agent (WORKSPACE-AGENTS.md §4.5).
//
// One reader, used by both places a summary is produced — the directory page a
// fresh client pages through, and the `actor.created` / `actor.updated` event a
// connected client receives — so the two cannot describe one agent differently.
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import type { AgentSummary } from '../sync/events.ts';

/**
 * Summaries for these actor ids. Ids that are not agents are simply absent.
 * One statement whatever the count: a directory page holds up to five hundred rows.
 *
 * `toolkits` is always empty since agents find their own tools (the plan's
 * step 7) — nothing picks toolkits for an agent any more. It is still sent
 * because clients built before step 7 require the field.
 */
export async function agentSummaries(
  db: Kysely<DB>, actorIds: readonly string[],
): Promise<Map<string, AgentSummary>> {
  const out = new Map<string, AgentSummary>();
  if (actorIds.length === 0) return out;

  const agents = await db.selectFrom('agents')
    .select(['actor_id', 'description', 'config_rev'])
    .where('actor_id', 'in', actorIds)
    .execute();
  for (const agent of agents) {
    out.set(agent.actor_id, { description: agent.description, config_rev: agent.config_rev, toolkits: [] });
  }
  return out;
}
