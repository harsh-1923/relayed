// The working indicator for one workspace agent run (docs/WORKSPACE-AGENTS.md
// §5.7, §5.8). Ephemeral — a live push, never a replica row — so it renders
// entirely from `useChatActivity` and disappears the moment `ended` arrives or
// the answer's own message lands beside it.
import { useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import type { RunActivity } from '@/lib/agent-activity';
import { useQuery } from '@/lib/query';
import { call } from '@/lib/ipc';
import { Button } from '@/components/ui/button';

interface RunIndicatorProps {
  run: RunActivity;
  /** Stop is the invoker's own affordance (§5.8) — only they may spend it. */
  isInvoker: boolean;
}

export function RunIndicator({ run, isInvoker }: RunIndicatorProps) {
  const { rows: actors } = useQuery('actors.list');
  const agent = actors?.find(actor => actor.id === run.agentId);
  const [stopping, setStopping] = useState(false);

  const label = run.state === 'waiting'
    ? `${agent?.displayName ?? 'Agent'} is busy — starting shortly`
    : run.label
      ? `${agent?.displayName ?? 'Agent'} is ${run.label}`
      : `${agent?.displayName ?? 'Agent'} is working`;

  return (
    <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground" role="status">
      <ThinkingOrb state={run.state === 'waiting' ? 'listening' : 'working'} size={20} aria-hidden />
      <span>{label}</span>
      {isInvoker && (
        <Button
          variant="ghost"
          size="xs"
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            void call(api => api.query('agents.stopRun', { runId: run.runId })).finally(() => {
              // No local state update on success: the `ended` push (or the
              // fallback of the run simply disappearing) is what removes
              // this — a second opinion here could only disagree with it.
              setStopping(false);
            });
          }}
        >
          Stop
        </Button>
      )}
    </div>
  );
}
