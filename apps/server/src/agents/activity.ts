// The working indicator (docs/WORKSPACE-AGENTS.md §5.7).
//
// A delivery-address push to the chat's audience, not a `sync_event`: it takes
// no revision, and a lost one is cosmetic — the reply arrives regardless
// (`SYNC-FLOWS.md`, read state and counters §15).
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import type { Registry } from '../sync/registry.ts';
import { pushToActor } from '../sync/fanout.ts';
import { spaceMembers, chatMembers } from '../sync/spaces.ts';

/** Sent on change, plus a refresh at most this often while nothing does (§5.7). */
export const REFRESH_MS = 60_000;

export interface ActivityState {
  chatId: string;
  threadId: string;
  agentId: string;
  runId: string;
  workspaceId: string;
  state: 'queued' | 'running' | 'waiting' | 'ended';
  label?: string;
}

interface Tracked extends ActivityState { seq: number; lastSentAtMs: number }

/**
 * The last state pushed for each run, in memory only. `seq` rises per run so
 * a client can drop anything that crossed a later push on the wire, and
 * `ended` is final: nothing pushes for a run again once it is here, which is
 * what stops a late "Searching Linear" landing after the answer.
 */
const lastByRun = new Map<string, Tracked>();

/** Everyone entitled to read this chat, resolved fresh — never held on a connection. */
async function chatAudience(db: Kysely<DB>, chatId: string): Promise<string[]> {
  const chat = await db.selectFrom('chats').select(['space_id', 'kind'])
    .where('id', '=', chatId).executeTakeFirst();
  if (!chat) return [];
  const members = await spaceMembers(db, chat.space_id);
  if (chat.kind !== 'private') return members;
  const inChat = new Set(await chatMembers(db, chatId));
  return members.filter(actorId => inChat.has(actorId));
}

function send(registry: Registry, tracked: Tracked, audience: readonly string[]): void {
  const body: Record<string, unknown> = {
    chat_id: tracked.chatId, thread_id: tracked.threadId, agent_id: tracked.agentId,
    run_id: tracked.runId, seq: tracked.seq, state: tracked.state,
    ...(tracked.label ? { label: tracked.label } : {}),
  };
  for (const actorId of audience) pushToActor(registry, actorId, tracked.workspaceId, 'agent_activity', body);
}

/** Push a genuine change. Always sends, and bumps `seq`. */
export async function notifyActivity(
  registry: Registry, db: Kysely<DB>, next: ActivityState,
): Promise<void> {
  const previous = lastByRun.get(next.runId);
  if (previous?.state === 'ended') return;   // final; nothing pushes for this run again
  const seq = (previous?.seq ?? -1) + 1;
  const tracked: Tracked = { ...next, seq, lastSentAtMs: Date.now() };
  lastByRun.set(next.runId, tracked);
  send(registry, tracked, await chatAudience(db, next.chatId));
  if (next.state === 'ended') {
    // Nothing needs the entry once the terminal push has gone out.
    setTimeout(() => { lastByRun.delete(next.runId); }, REFRESH_MS).unref?.();
  }
}

/**
 * Re-send anything still active whose last push is older than `REFRESH_MS` —
 * so a client that reconnects mid-run learns the state without every member
 * of the chat being pushed to on every dispatcher tick.
 */
export async function refreshStaleActivity(registry: Registry, db: Kysely<DB>): Promise<void> {
  const now = Date.now();
  for (const tracked of lastByRun.values()) {
    if (tracked.state === 'ended' || now - tracked.lastSentAtMs < REFRESH_MS) continue;
    tracked.lastSentAtMs = now;
    send(registry, tracked, await chatAudience(db, tracked.chatId));
  }
}

/** Test seam: forget everything tracked, so one test's runs cannot leak into another's. */
export function resetActivityForTest(): void { lastByRun.clear(); }
