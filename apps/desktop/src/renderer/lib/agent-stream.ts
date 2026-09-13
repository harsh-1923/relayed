// The text Claude is writing right now, for one reply (docs/LOCAL-ROOMS.md §8.3).
//
// Pushed, never stored, and never an invalidation: re-reading a growing message
// thirty times a second is the waste coarse invalidation exists to avoid. A
// window that mounts mid-reply shows the stored parts and picks the live text up
// from the next push; a lost push is cosmetic, because the parts carry the text
// when the turn ends.
import { useEffect, useState } from 'react';
import type { AgentStream } from '../../preload/api';
import { bridge } from '@/lib/ipc';

export interface LiveReply {
  /** The text block arriving now, or ''. */
  text: string;
  /** The source of a UI block arriving now, or null. */
  ui: string | null;
}

const NOTHING: LiveReply = { text: '', ui: null };

/** What is arriving for `messageId` right now. Subscribes only while `active`. */
export function useAgentStream(messageId: string, active: boolean): LiveReply {
  const [live, setLive] = useState<LiveReply>(NOTHING);

  useEffect(() => {
    if (!active) { setLive(NOTHING); return; }
    return bridge()?.subscribe('agent:stream', (stream: AgentStream) => {
      if (stream.messageId === messageId) setLive({ text: stream.text, ui: stream.ui });
    });
  }, [messageId, active]);

  return active ? live : NOTHING;
}
