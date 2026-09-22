// The working indicator for one workspace agent run (docs/WORKSPACE-AGENTS.md
// §5.7, §5.8). Ephemeral — a live push, never a replica row — so it renders
// entirely from `useChatActivity` and disappears the moment `ended` arrives or
// the answer's own message lands beside it.
import { useState } from 'react';
import type { RunActivity } from '@/lib/agent-activity';
import { useActor } from '@/lib/actors';
import { ActorAvatar } from '@/components/ActorAvatar';
import { useRunPosture } from '@/lib/agent-posture';
import { call } from '@/lib/ipc';
import { Button } from '@/components/ui/button';

interface RunIndicatorProps {
  run: RunActivity;
  /** Stop is the invoker's own affordance (§5.8) — only they may spend it. */
  isInvoker: boolean;
}

export function RunIndicator({ run, isInvoker }: RunIndicatorProps) {
  const agent = useActor(run.agentId);
  const [stopping, setStopping] = useState(false);
  // The one surface with live run data, so the one that can honestly drive a
  // posture. Everywhere else an agent's face rests.
  const posture = useRunPosture(run);

  const label = run.state === 'waiting'
    ? `${agent?.displayName ?? 'Agent'} is busy — starting shortly`
    : run.label
      ? `${agent?.displayName ?? 'Agent'} is ${run.label}`
      : `${agent?.displayName ?? 'Agent'} is working`;

  return (
    <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground" role="status">
      {/* The agent's OWN face, working, rather than a generic orb: the row
          already names who is running, and one indicator that is both the
          identity and the state beats two things side by side saying half each. */}
      <ActorAvatar id={run.agentId} activity={posture} className="size-5" />
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
