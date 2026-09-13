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
  /** One chat's message list. */
  messages: (chatId: string): string => `chat:${chatId}:messages`,
  /** One chat's badge — head, unread, mentions. Separate from its messages. */
  chatState: (chatId: string): string => `chat:${chatId}:state`,
  /** One space: its name, its chats, who is in it. */
  space: (spaceId: string): string => `space:${spaceId}`,
  /** The sidebar's own list of spaces. Woken by a join or a leave. */
  spaces: (): string => 'spaces',
  /** Everything a person has chosen. What `prefs.list` reads. */
  prefs: (): string => 'prefs',
  /** The person's own Claude Code: installed, signed in, who as (LOCAL-ROOMS.md §3.2). */
  claude: (): string => 'claude',
  /**
   * Local rooms, under their own root (LOCAL-ROOMS.md §7). Not `space:` or
   * `chat:`: a local room is not in the replica, and a workspace switch — which
   * wakes every replica read — must not tear down a chat Claude is writing in.
   */
  localRooms: (): string => 'local:rooms',
  localMessages: (chatId: string): string => `local:chat:${chatId}:messages`,
  /** Every local room's slash commands. One topic: lists change rarely, and a read is a map lookup. */
  localCommands: (): string => 'local:commands',
  /** What Claude Code is waiting on the person for in one local chat. */
  localApprovals: (chatId: string): string => `local:chat:${chatId}:approvals`,
  /** One workspace chat's locally authored draft. */
  draft: (chatId: string): string => `chat:${chatId}:draft`,
  /** One local-room chat's locally authored draft. */
  localDraft: (chatId: string): string => `local:chat:${chatId}:draft`,
  /**
   * One preference.
   *
   * WRITTEN FINE, SUBSCRIBED COARSE (PREFERENCES.md §8). A write names the key
   * it changed and the reader subscribes to `prefs`, which the prefix rule
   * below already matches — so per-key granularity costs nothing today and is
   * there the moment a surface wants it.
   *
   * Keys are dotted and topics are colon-separated, which is why
   * `appearance.theme` is one segment here rather than two.
   */
  pref: (key: string): string => `prefs:${key}`,
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
