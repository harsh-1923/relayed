// Activity: someone doing something in a chat, right now (docs/ACTIVITY.md).
//
// A delivery-address push to the chat's audience, not a `sync_event`: it takes
// no revision, nothing stores it, and a lost one is cosmetic — whatever the
// activity leads to (a reply, a message) arrives through the synced path
// regardless (`SYNC-FLOWS.md`, read state and counters §15).
//
// IN MEMORY ONLY, which is right under the one-instance rule (`DEPLOY.md`).
// A restart empties it; every client reconnects and starts from nothing.
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import type { Registry } from './registry.ts';
import { pushToActor } from './fanout.ts';
import { spaceMembers, chatMembers } from './spaces.ts';

export type ActivityKind = 'run' | 'typing';

/** One actor doing one thing in one chat (ACTIVITY.md §3.1). */
export interface ActivityEntry {
  kind: ActivityKind;
  /** Distinct per activity of a kind. `run`: the run id. `typing`: actor and connection. */
  key: string;
  chatId: string;
  /** Null for the chat itself. For a run, the thread its reply goes in. */
  threadId: string | null;
  actorId: string;
  workspaceId: string;
  state: 'active' | 'ended';
  label?: string;
}

interface Policy {
  /** Once `ended`, nothing pushes for this key again — stops a late label landing after the answer. */
  finalEnd: boolean;
  /** Re-send an active entry this often while nothing changes, for clients that reconnected. */
  refreshMs: number | null;
  /** How long an entry lives without a fresh push. Receivers time it themselves, from arrival. */
  ttlMs: number | null;
  /** An unchanged `active` sooner than this after the last push for the key is dropped. */
  minIntervalMs: number;
  /** Whether the actor doing it is sent it. Nobody needs to be told they are typing. */
  skipActor: boolean;
  /** Not sent at all to a chat with more readers than this (§10). */
  audienceCap: number | null;
  /** The frames each receiver gets. One kind may send more than one while a frame is renamed (§8). */
  frames(entry: Tracked): Array<[t: string, body: Record<string, unknown>]>;
}

interface Tracked extends ActivityEntry { seq: number; lastSentAtMs: number; expiry?: NodeJS.Timeout }

/** How long a typing entry lives without a fresh `active` (§3.2). The client re-sends every 3 s. */
export const TYPING_TTL_MS = 6_000;
/** No typing in a chat with more readers than this (§10). */
export const TYPING_AUDIENCE_CAP = 100;

/** Everything that differs between kinds (ACTIVITY.md §3.2). */
const POLICY: Record<ActivityKind, Policy> = {
  run: {
    finalEnd: true, refreshMs: 60_000, ttlMs: null, minIntervalMs: 0,
    skipActor: false, audienceCap: null,
    frames: entry => [['agent_activity', {
      chat_id: entry.chatId, thread_id: entry.threadId, agent_id: entry.actorId,
      run_id: entry.key, seq: entry.seq, state: entry.state === 'active' ? 'running' : 'ended',
      ...(entry.label ? { label: entry.label } : {}),
    }]],
  },
  typing: {
    finalEnd: false, refreshMs: null, ttlMs: TYPING_TTL_MS, minIntervalMs: 1_000,
    skipActor: true, audienceCap: TYPING_AUDIENCE_CAP,
    frames: entry => [['activity', {
      chat_id: entry.chatId, thread_id: entry.threadId, actor_id: entry.actorId,
      kind: entry.kind, key: entry.key, seq: entry.seq, state: entry.state,
      ...(entry.state === 'active' ? { ttl_ms: TYPING_TTL_MS } : {}),
    }]],
  },
};

/** Who may see activity in a chat. Passed in so the rules here are testable without a database. */
export type Audience = (chatId: string) => Promise<readonly string[]>;

/** Everyone entitled to read this chat, resolved fresh — never held on a connection. */
export function chatAudience(db: Kysely<DB>): Audience {
  return async chatId => {
    const chat = await db.selectFrom('chats').select(['space_id', 'kind'])
      .where('id', '=', chatId).executeTakeFirst();
    if (!chat) return [];
    const members = await spaceMembers(db, chat.space_id);
    if (chat.kind !== 'private') return members;
    const inChat = new Set(await chatMembers(db, chatId));
    return members.filter(actorId => inChat.has(actorId));
  };
}

/**
 * The same audience, remembered for `ms` per chat (§5.3). Typing asks every
 * few seconds per typist; a membership change mid-sentence costing one stale
 * push is not worth three queries a frame.
 */
export function cachedAudience(audience: Audience, ms: number): Audience {
  const held = new Map<string, { ids: readonly string[]; at: number }>();
  return async chatId => {
    const now = Date.now();
    const hit = held.get(chatId);
    if (hit && now - hit.at < ms) return hit.ids;
    const ids = await audience(chatId);
    held.set(chatId, { ids, at: now });
    // Swept as it goes, so a server that has seen every chat once does not hold every chat for ever.
    for (const [id, entry] of held) if (now - entry.at >= ms) held.delete(id);
    return ids;
  };
}

/**
 * The last state pushed for each activity, by kind and key. `seq` rises per
 * key so a client can drop anything that crossed a later push on the wire.
 */
const entries = new Map<string, Tracked>();

const idOf = (kind: ActivityKind, key: string): string => `${kind}:${key}`;

function forget(id: string, tracked: Tracked): void {
  if (tracked.expiry) clearTimeout(tracked.expiry);
  if (entries.get(id) === tracked) entries.delete(id);
}

function send(registry: Registry, tracked: Tracked, audience: readonly string[]): void {
  const policy = POLICY[tracked.kind];
  if (policy.audienceCap !== null && audience.length > policy.audienceCap) return;
  for (const [t, body] of policy.frames(tracked)) {
    for (const actorId of audience) {
      if (policy.skipActor && actorId === tracked.actorId) continue;
      pushToActor(registry, actorId, tracked.workspaceId, t, body);
    }
  }
}

/**
 * Push a genuine change. Bumps `seq` and sends — unless the key has already
 * ended for good, or it is an unchanged `active` inside the kind's interval.
 * Returns whether anything was sent.
 */
export async function publishActivity(
  registry: Registry, audience: Audience, next: ActivityEntry,
): Promise<boolean> {
  const policy = POLICY[next.kind];
  const id = idOf(next.kind, next.key);
  const previous = entries.get(id);
  if (policy.finalEnd && previous?.state === 'ended') return false;
  // Ending something that is not happening is a no-op, not a push to everyone.
  if (!policy.finalEnd && next.state === 'ended' && !previous) return false;
  const now = Date.now();
  if (previous?.state === 'active' && next.state === 'active'
      && previous.threadId === next.threadId && previous.label === next.label
      && now - previous.lastSentAtMs < policy.minIntervalMs) return false;

  if (previous?.expiry) clearTimeout(previous.expiry);
  const tracked: Tracked = { ...next, seq: (previous?.seq ?? -1) + 1, lastSentAtMs: now };
  entries.set(id, tracked);
  if (next.state === 'active' && policy.ttlMs !== null) {
    // The server's copy expires as the receivers' do: nothing is pushed, because
    // each of them is already counting down the same `ttl_ms` on its own.
    tracked.expiry = setTimeout(() => { forget(id, tracked); }, policy.ttlMs);
    tracked.expiry.unref?.();
  }
  send(registry, tracked, await audience(next.chatId));
  if (next.state === 'ended') {
    if (policy.finalEnd && policy.refreshMs !== null) {
      // A final end is kept a while, so a push arriving after it is still refused.
      tracked.expiry = setTimeout(() => { forget(id, tracked); }, policy.refreshMs);
      tracked.expiry.unref?.();
    } else {
      forget(id, tracked);
    }
  }
  return true;
}

/**
 * End every active entry of a kind whose key starts with `keyPrefix` — a
 * connection closing ends everything it was typing, rather than leaving it
 * to expire.
 */
export async function endActivityWhere(
  registry: Registry, audience: Audience, kind: ActivityKind, keyPrefix: string,
): Promise<void> {
  const ending = [...entries.values()]
    .filter(t => t.kind === kind && t.state === 'active' && t.key.startsWith(keyPrefix));
  for (const tracked of ending) {
    const { seq: _seq, lastSentAtMs: _sent, expiry: _expiry, ...entry } = tracked;
    await publishActivity(registry, audience, { ...entry, state: 'ended' });
  }
}

/**
 * Re-send anything still active whose last push is older than its kind's
 * `refreshMs` — so a client that reconnects mid-activity learns the state
 * without every member of the chat being pushed to on every tick.
 */
export async function refreshActivity(registry: Registry, audience: Audience): Promise<void> {
  const now = Date.now();
  for (const tracked of entries.values()) {
    const refreshMs = POLICY[tracked.kind].refreshMs;
    if (tracked.state === 'ended' || refreshMs === null || now - tracked.lastSentAtMs < refreshMs) continue;
    tracked.lastSentAtMs = now;
    send(registry, tracked, await audience(tracked.chatId));
  }
}

/** Test seam: forget everything tracked, so one test's activity cannot leak into another's. */
export function resetActivityForTest(): void {
  for (const tracked of entries.values()) if (tracked.expiry) clearTimeout(tracked.expiry);
  entries.clear();
}
