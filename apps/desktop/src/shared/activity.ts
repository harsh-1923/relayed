// Someone doing something in a chat, right now (docs/ACTIVITY.md). Pushed to
// the renderer as it arrives; never stored, never an invalidation.
export interface Activity {
  chat_id: string;
  /** Null for the chat itself; otherwise the thread root. */
  thread_id: string | null;
  actor_id: string;
  /** `typing` today. A kind the renderer does not know is ignored. */
  kind: string;
  /** Distinct per activity of a kind; `seq` rises per key. */
  key: string;
  seq: number;
  state: 'active' | 'ended';
  /** Drop it this long after it ARRIVED, by this machine's clock. */
  ttl_ms?: number;
  label?: string;
}

/**
 * One push on the channel: an activity, or `reset` — the socket went down or
 * reconnected, so nothing held is known to be true any more (§6.1).
 */
export type ActivityPush = { activity: Activity } | { reset: true };

export const ACTIVITY_CHANNEL = 'activity' as const;
