// Activity, live (docs/ACTIVITY.md §6). Pushed, never stored, and never an
// invalidation — the same reason `useChatActivity` gives for runs.
//
// ONE subscription for the whole window, opened by the first surface that
// asks, rather than one per mounted chat: typing that started before a chat
// was opened is then already held when it opens, instead of appearing only at
// the typist's next refresh.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ActivityPush } from '../../../preload/api';
import { bridge, call } from '@/lib/ipc';
import { applyPush, expire, nextExpiry, typistsIn, type Held } from './held.ts';
import { TypingSender } from './typing-sender.ts';

let held: Held = new Map();
const listeners = new Set<() => void>();
let subscribed = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function update(next: Held): void {
  if (next === held) return;
  held = next;
  schedule();
  for (const listener of listeners) listener();
}

/** One timer, for whichever entry expires next. */
function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const at = nextExpiry(held);
  if (at === null) return;
  timer = setTimeout(() => { update(expire(held, Date.now())); }, Math.max(0, at - Date.now()));
}

function subscribe(listener: () => void): () => void {
  if (!subscribed) {
    const api = bridge();
    if (api) {
      subscribed = true;
      api.subscribe('activity', (push: ActivityPush) => { update(applyPush(held, push, Date.now())); });
    }
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const snapshot = (): Held => held;

/** Who is typing in this chat or thread, once each, in the order they started. */
export function useTypists(chatId: string, threadId: string | null = null): string[] {
  const current = useSyncExternalStore(subscribe, snapshot);
  return useMemo(() => typistsIn(current, chatId, threadId), [current, chatId, threadId]);
}

/**
 * The composer's half (§6.2): call `changed` on every edit and `stop` on send.
 * Ends on unmount, which is also switching chats — the composer is keyed by it.
 * Disabled for a local room, which has no other viewer.
 */
export function useTypingSender(chatId: string, enabled: boolean): TypingSender | null {
  const sender = useMemo(() => enabled
    ? new TypingSender(state => {
        void call(api => api.query('activity.send', { chatId, threadId: null, state })).catch(() => {
          // Cosmetic and best effort: a lost typing frame expires on its own.
        });
      })
    : null, [chatId, enabled]);
  useEffect(() => () => { sender?.stop(); }, [sender]);
  return sender;
}
