// The posture of a unit of work, live.
//
// The whole decision is in one hook so a caller never has to make it
// conditionally: `known` is what the host can actually observe, `runId` is what
// seeds the invented cycle when it cannot observe anything, and the absence of
// both is idle. A host wires its own run record into those two fields and never
// touches the schedule itself.
//
// Two things this deliberately does NOT do:
//
//   - It does not tick on an interval. A posture lasts seconds, so waking every
//     frame to ask whether it changed would burn a render loop to answer "no"
//     several hundred times per change. It sleeps exactly until the next slot
//     boundary and wakes once.
//   - It does not keep the posture in state and step it forward. The posture is
//     recomputed from elapsed time, so a component that mounts halfway through
//     a run agrees with one that has been mounted the whole time — which is the
//     property that lets the same run be drawn in two places at once.
import { useEffect, useRef, useState } from 'react';
import type { AgentActivity } from '../activity.ts';
import { postureAt, scheduleFor } from '../posture.ts';

export interface PostureInput {
  /**
   * Stable id for the work in flight, or null when nothing is. Seeds the cycle,
   * so the same id draws the same sequence everywhere it is shown.
   */
  runId?: string | null;
  /**
   * A posture the host has actually observed. Wins over the cycle outright —
   * this is the field that makes the invented one retire on its own as a
   * runtime starts reporting more.
   */
  known?: AgentActivity | null;
}

export function useAgentPosture({ runId = null, known = null }: PostureInput): AgentActivity {
  // When this run was first seen. Runs rarely carry a start instant, and one
  // already in flight when a window opened would otherwise begin mid-schedule —
  // harmless, but this keeps a freshly started run's first posture honest.
  const started = useRef<{ runId: string; at: number } | null>(null);
  const [, tick] = useState(0);

  if (runId && started.current?.runId !== runId) {
    started.current = { runId, at: Date.now() };
  }

  const cycling = !known && runId !== null;
  const elapsed = runId && started.current ? Date.now() - started.current.at : 0;

  useEffect(() => {
    if (!cycling || !runId) return;

    const { slots, total } = scheduleFor(runId);
    const at = elapsed % total;
    const next = slots.find(slot => at < slot.until)?.until ?? total;
    // +16ms so the timer lands just PAST the boundary; firing exactly on it can
    // recompute the same slot and schedule a zero-length timeout forever.
    const timer = setTimeout(() => tick(n => n + 1), next - at + 16);
    return () => clearTimeout(timer);
  }, [cycling, runId, elapsed]);

  if (known) return known;
  if (!runId) return 'idle';
  return postureAt(runId, elapsed);
}
