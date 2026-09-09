// The dependency vocabulary, shared by the sync engine and the renderer.
//
// The write side names WHAT IT CHANGED; the read side names WHAT IT READS; the
// live-query registry matches the two. Both halves live here rather than one in
// each process, because drift between them fails silently: a topic nobody
// subscribes to invalidates nothing, and the symptom is a surface that quietly
// stops refreshing. There is no error, no rejected promise, and nothing in a
// log — which is precisely the bug the live-query client exists to remove.
//
// Constructed through `topic`, never written as a string literal, for the same
// reason: a typo has to be a compile error, because it cannot be a runtime one.

/**
 * A topic is colon-separated segments, ordered coarse to fine:
 *
 *   actors                     the whole directory
 *   actors:<actorId>           one actor
 *   chat:<chatId>              anything in one chat
 *   chat:<chatId>:messages     only its messages
 *   chat:<chatId>:unread       only its counters
 *
 * Only the entries below exist today. The grammar is written out because the
 * shape of a new one is the decision worth getting right — a facet appended
 * under an existing prefix inherits its readers for free, whereas a new
 * top-level word inherits nothing.
 */
/**
 * The push channel invalidations arrive on.
 *
 * Named here so the two processes cannot disagree. The sync engine stamps it on
 * the frame and the renderer subscribes with it; a typo in either is a channel
 * nobody listens to, which fails exactly as silently as a wrong topic. `as
 * const` is what lets the preload's typed overload check the renderer half —
 * change this string and `api.subscribe` stops compiling.
 */
export const INVALIDATE_CHANNEL = 'invalidate' as const;

export const topic = {
  /** The workspace directory: every actor in it. */
  actors: (): string => 'actors',
} as const;

/**
 * Do a subscription and an invalidation refer to overlapping data?
 *
 * True when either is a prefix of the other, and BOTH directions carry weight:
 *
 *   write 'chat:c_eng:messages'  must wake a sidebar subscribed to 'chat'
 *   write 'actors'               must wake a card subscribed to 'actors:a_alice'
 *
 * Drop the second direction and a full directory resync — which cannot name
 * which actors changed — leaves every open profile showing yesterday's name.
 */
export function topicsIntersect(subscribed: string, invalidated: string): boolean {
  if (subscribed === invalidated) return true;
  const shorter = subscribed.length < invalidated.length ? subscribed : invalidated;
  const longer = shorter === subscribed ? invalidated : subscribed;
  // The trailing ':' is load-bearing. Without it a write to 'chat:c_engineering'
  // wakes everything subscribed to 'chat:c_eng', and the symptom is a pane that
  // refetches slightly too often — which nobody ever investigates.
  return longer.startsWith(`${shorter}:`);
}

/** Does any subscribed topic intersect any invalidated one? */
export function topicsTouched(
  subscribed: readonly string[],
  invalidated: readonly string[],
): boolean {
  for (const subscribedTopic of subscribed) {
    for (const invalidatedTopic of invalidated) {
      if (topicsIntersect(subscribedTopic, invalidatedTopic)) return true;
    }
  }
  return false;
}
