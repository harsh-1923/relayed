// Keeping a face alive through an interval nothing is reported during.
//
// Most agent runtimes report that work is happening and nothing about WHAT is
// happening. Such an interval can last half a minute, and a face frozen in one
// expression for half a minute is not an idle creature, it is a dead one.
//
// So a running agent CYCLES through the working postures, and the cycle is
// invented rather than observed. That is a real thing to be uneasy about, so it
// is worth being exact about why it is acceptable and where it stops being
// acceptable:
//
//   - Only the postures that are true AT ANY MOMENT of a run are in the cycle.
//     An agent that is running genuinely is thinking, searching and calling
//     tools, in some order we cannot see. Showing one of them is a plausible
//     depiction of an unobserved interval, the way a progress bar's motion
//     depicts work without measuring it.
//   - The postures that make a CLAIM are excluded, and that is the boundary.
//     `speaking` says the reply is being written now. `done` and `failed` say
//     how it ended. `laser` says this part is harder than the rest. None of
//     those can be invented, because each is a specific assertion a person
//     could catch us getting wrong — and each has, or will have, a real signal.
//   - A real signal always wins. A host that knows the posture passes it as
//     `known` and the cycle is never consulted, so the day a runtime starts
//     reporting detail, this quietly stops being used for the intervals that
//     detail covers — with nothing here to change.
//
// The schedule is derived from the run id, so every surface showing the same
// run shows the same face at the same time — two places drawing one agent are
// not allowed to disagree about what it is doing.
import type { AgentActivity } from './activity.ts';

/**
 * The postures a run can be depicted in without asserting anything specific.
 * Adding to this list is a claim; think about it before you do.
 */
const CYCLE: AgentActivity[] = ['thinking', 'searching', 'working'];

/** Dwell bounds, in ms. Short enough to feel alive, long enough to read. */
const MIN_DWELL = 2400;
const MAX_DWELL = 5200;

/** Slots in one loop. The schedule repeats after this; runs rarely outlive it. */
const SLOTS = 12;

function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rng(state: number): () => number {
  let a = state || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PostureSlot { activity: AgentActivity; until: number }

/**
 * The fixed schedule for one run: which posture, and until when.
 *
 * Precomputed rather than stepped, so the posture is a pure function of elapsed
 * time — no accumulated state to drift, and a component that mounts late lands
 * on the same face as one that has been watching from the start.
 */
export function scheduleFor(runId: string): { slots: PostureSlot[]; total: number } {
  const random = rng(hash(runId));
  const slots: PostureSlot[] = [];
  let at = 0;
  // Every run starts by thinking. That is not a guess — there is always a model
  // turn before the first tool call.
  let previous: AgentActivity = 'thinking';
  for (let i = 0; i < SLOTS; i++) {
    const activity = i === 0
      ? 'thinking'
      // Never twice in a row: a repeat looks like the animation has stalled.
      : CYCLE.filter(name => name !== previous)[Math.floor(random() * (CYCLE.length - 1))]!;
    at += MIN_DWELL + random() * (MAX_DWELL - MIN_DWELL);
    slots.push({ activity, until: at });
    previous = activity;
  }
  return { slots, total: at };
}

/**
 * Where the cycle for `runId` has got to after `elapsed` ms.
 *
 * Pure, and the schedule repeats, so this answers for any elapsed time without
 * the caller holding anything but a start instant.
 */
export function postureAt(runId: string, elapsed: number): AgentActivity {
  const { slots, total } = scheduleFor(runId);
  const at = elapsed % total;
  return (slots.find(slot => at < slot.until) ?? slots[slots.length - 1]!).activity;
}
