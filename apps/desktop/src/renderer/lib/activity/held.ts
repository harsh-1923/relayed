// What this window knows about who is doing what, right now (docs/ACTIVITY.md
// §6.3). Pure, so every rule runs under `node --test`; `use-activity.ts` owns
// the subscription and the timer.
//
// Each operation returns the SAME map when nothing changed, so a store over it
// can tell a real change from a push it dropped without comparing contents.
import type { ActivityPush } from '../../../shared/activity.ts';

export interface HeldActivity {
  chatId: string;
  threadId: string | null;
  actorId: string;
  kind: string;
  key: string;
  seq: number;
  label?: string;
  /** By this machine's clock — arrival plus `ttl_ms`. Null lives until ended. */
  expiresAt: number | null;
}

export type Held = ReadonlyMap<string, HeldActivity>;

/** The kinds this build draws. Anything else arriving is ignored (§4.3). */
const KNOWN_KINDS: ReadonlySet<string> = new Set(['typing']);

const idOf = (kind: string, key: string): string => `${kind}:${key}`;

export function applyPush(held: Held, push: ActivityPush, now: number): Held {
  if ('reset' in push) return held.size === 0 ? held : new Map();
  const { activity } = push;
  if (!KNOWN_KINDS.has(activity.kind)) return held;
  const id = idOf(activity.kind, activity.key);
  const previous = held.get(id);
  // Pushes can cross on the wire: anything older than what is held is stale.
  if (previous && activity.seq <= previous.seq) return held;
  if (activity.state === 'ended') {
    if (!previous) return held;
    const next = new Map(held);
    next.delete(id);
    return next;
  }
  const next = new Map(held);
  next.set(id, {
    chatId: activity.chat_id, threadId: activity.thread_id, actorId: activity.actor_id,
    kind: activity.kind, key: activity.key, seq: activity.seq,
    ...(activity.label !== undefined ? { label: activity.label } : {}),
    expiresAt: activity.ttl_ms !== undefined ? now + activity.ttl_ms : null,
  });
  return next;
}

/** Without whatever has expired by `now`. */
export function expire(held: Held, now: number): Held {
  let next: Map<string, HeldActivity> | null = null;
  for (const [id, entry] of held) {
    if (entry.expiresAt === null || entry.expiresAt > now) continue;
    next ??= new Map(held);
    next.delete(id);
  }
  return next ?? held;
}

/** When the next entry expires, or null when none will. */
export function nextExpiry(held: Held): number | null {
  let soonest: number | null = null;
  for (const entry of held.values()) {
    if (entry.expiresAt !== null && (soonest === null || entry.expiresAt < soonest)) soonest = entry.expiresAt;
  }
  return soonest;
}

/**
 * Who is typing here, once each — two devices are one person — in the order
 * they started, so a face does not jump about as others join.
 */
export function typistsIn(held: Held, chatId: string, threadId: string | null): string[] {
  const seen = new Set<string>();
  for (const entry of held.values()) {
    if (entry.kind === 'typing' && entry.chatId === chatId && entry.threadId === threadId) seen.add(entry.actorId);
  }
  return [...seen];
}
