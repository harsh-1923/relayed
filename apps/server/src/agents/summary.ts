// What every member's client holds about an agent (WORKSPACE-AGENTS.md §4.5).
//
// One reader, used by both places a summary is produced — the directory page a
// fresh client pages through, and the `actor.created` / `actor.updated` event a
// connected client receives — so the two cannot describe one agent differently.
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import type { AgentSummary } from '../sync/events.ts';

const RANK = { read: 0, write: 1, destructive: 2 } as const;
type Effect = keyof typeof RANK;

/**
 * Summaries for these actor ids. Ids that are not agents are simply absent.
 *
 * Two statements whatever the count — the definitions, then every tool of those
 * agents — never one per agent: a directory page holds up to five hundred rows.
 * The per-toolkit maximum is taken here rather than in SQL because the order of
 * effects is ours, not the alphabet's (`write` sorts after `destructive`).
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
  if (agents.length === 0) return out;

  const tools = await db.selectFrom('agent_tools')
    .select(['agent_actor_id', 'toolkit', 'effect'])
    .where('agent_actor_id', 'in', agents.map(a => a.actor_id))
    .execute();

  const byAgent = new Map<string, Map<string, Effect>>();
  for (const t of tools) {
    const kits = byAgent.get(t.agent_actor_id) ?? new Map<string, Effect>();
    const held = kits.get(t.toolkit);
    if (held === undefined || RANK[t.effect] > RANK[held]) kits.set(t.toolkit, t.effect);
    byAgent.set(t.agent_actor_id, kits);
  }

  for (const a of agents) {
    const kits = byAgent.get(a.actor_id) ?? new Map<string, Effect>();
    out.set(a.actor_id, {
      description: a.description,
      config_rev: a.config_rev,
      toolkits: [...kits].sort(([x], [y]) => x.localeCompare(y))
        .map(([toolkit, effect]) => ({ toolkit, effect })),
    });
  }
  return out;
}
