// The working indicator (docs/WORKSPACE-AGENTS.md §5.7): a run's activity,
// published through the generic register (docs/ACTIVITY.md) as `kind: 'run'`.
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import type { Registry } from '../sync/registry.ts';
import { chatAudience, publishActivity, refreshActivity } from '../sync/activity.ts';

export interface RunActivityState {
  chatId: string;
  /** The thread the reply goes in — `replyParentOf`, for every push including `ended`. */
  threadId: string;
  agentId: string;
  runId: string;
  workspaceId: string;
  state: 'running' | 'ended';
  label?: string;
}

/** Push a genuine change in a run. */
export async function notifyActivity(
  registry: Registry, db: Kysely<DB>, next: RunActivityState,
): Promise<void> {
  await publishActivity(registry, chatAudience(db), {
    kind: 'run', key: next.runId, chatId: next.chatId, threadId: next.threadId,
    actorId: next.agentId, workspaceId: next.workspaceId,
    state: next.state === 'running' ? 'active' : 'ended',
    ...(next.label ? { label: next.label } : {}),
  });
}

/** Re-send any run still working whose last push has gone stale. */
export async function refreshStaleActivity(registry: Registry, db: Kysely<DB>): Promise<void> {
  await refreshActivity(registry, chatAudience(db));
}
