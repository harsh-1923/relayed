// The working indicator, live (docs/WORKSPACE-AGENTS.md §5.7).
//
// Pushed, never stored, and never an invalidation — same shape as
// `useAgentStream` (agent-stream.ts) for the same reason: re-deriving this
// from the replica would mean storing something whose only purpose is to
// disappear the moment the real reply lands.
import { useEffect, useState } from 'react';
import type { AgentActivity } from '../../preload/api';
import { bridge } from '@/lib/ipc';

export interface RunActivity {
  runId: string;
  agentId: string;
  threadId: string;
  state: 'queued' | 'running' | 'waiting';
  label?: string;
}

interface Tracked extends RunActivity { seq: number }

/**
 * Every run currently working or waiting in this chat.
 *
 * `seq` rises per run and `ended` is final (§5.7): pushes can cross on the
 * wire, so a lower `seq` than what is held is dropped rather than resurrecting
 * a finished indicator, and `ended` removes the run rather than being shown.
 */
export function useChatActivity(chatId: string): RunActivity[] {
  const [byRun, setByRun] = useState<Map<string, Tracked>>(new Map());

  useEffect(() => {
    setByRun(new Map());
    return bridge()?.subscribe('agent:activity', (activity: AgentActivity) => {
      if (activity.chat_id !== chatId) return;
      setByRun(prev => {
        const held = prev.get(activity.run_id);
        if (held && activity.seq < held.seq) return prev;
        const next = new Map(prev);
        if (activity.state === 'ended') next.delete(activity.run_id);
        else {
          next.set(activity.run_id, {
            runId: activity.run_id, agentId: activity.agent_id, threadId: activity.thread_id,
            state: activity.state, seq: activity.seq,
            ...(activity.label !== undefined ? { label: activity.label } : {}),
          });
        }
        return next;
      });
    });
  }, [chatId]);

  return [...byRun.values()].map(({ runId, agentId, threadId, state, label }) =>
    ({ runId, agentId, threadId, state, ...(label !== undefined ? { label } : {}) }));
}
