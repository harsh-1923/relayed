// What an agent is DOING, as the avatars perform it.
//
// One vocabulary shared by both avatar families, so a state means the same
// thing whichever face a host ends up drawing.
//
// NOTHING HERE KNOWS WHAT A RUN LOOKS LIKE. Translating a host's own run or job
// record into one of these is the host's job — see `activityForTool` for the
// only piece of that worth sharing, and the README for why the line is here.
//
// The vocabulary is deliberately about POSTURE, not about tools. "searching"
// is a thing a creature does with its eyes; `LINEAR_SEARCH_ISSUES` is a thing
// a runtime does with an API. Keeping the avatar's words on the creature's
// side is what lets the tool list change without anyone re-choreographing an
// animation.
import type { EyeMood } from './geometry/eyes.ts';

export type AgentActivity =
  /** Nothing in flight. Alive, but idle. */
  | 'idle'
  /** Queued behind another run: awake, looking away, waiting its turn. */
  | 'waiting'
  /** Between tool calls — the head turns as it turns something over. */
  | 'thinking'
  /** Casting about for something. Wide, fast, restless eyes. */
  | 'searching'
  /** Hands on a tool. Narrowed and steady. */
  | 'working'
  /** Working, harder. Narrowed to points, leaning in, nothing wandering. */
  | 'laser'
  /** Delivering its reply. */
  | 'speaking'
  /** Finished well. */
  | 'done'
  /** Finished badly. */
  | 'failed';

export const AGENT_ACTIVITIES: AgentActivity[] = [
  'idle', 'waiting', 'thinking', 'searching', 'working', 'laser', 'speaking', 'done', 'failed',
];

/** A one-liner per state, for the playground's labels. */
export const ACTIVITY_NOTES: Record<AgentActivity, string> = {
  idle: 'Gaze wanders, blinks, breathes. Three clocks, none in step.',
  waiting: 'Looks away and down. Slow lids. Queued behind another run.',
  thinking: 'The head itself turns while the gaze circles — turning something over.',
  searching: 'Fast wide saccades with the head lagging behind. Rarely blinks.',
  working: 'Eyes narrow to points and lock. A short working pulse.',
  laser: 'Narrowed further, converged inward, leaning in. Nothing wanders.',
  speaking: 'Open and warm, bobbing as it talks.',
  done: 'One settle, then back to idle.',
  failed: 'A flinch, then wary.',
};

/**
 * Which eye shape a state wears. The seeded mood is the agent's RESTING face;
 * a state overrides it and then gives it back, so identity survives the run —
 * the colour never moves, and neither does anything else about who this is.
 */
export const ACTIVITY_MOOD: Record<AgentActivity, EyeMood | null> = {
  idle: null,
  waiting: 'sleepy',
  thinking: 'curious',
  searching: 'neutral',
  working: 'focused',
  laser: 'focused',
  speaking: 'happy',
  done: 'happy',
  failed: 'wary',
};

/**
 * How the segment family reads a state: the cuts travel faster and further
 * when there is more going on. It has no eyes to narrow, so pace is the only
 * register it has.
 */
export const ACTIVITY_MOTION: Record<AgentActivity, { duration: number; amount: number }> = {
  idle: { duration: 6, amount: 3 },
  waiting: { duration: 10, amount: 1.5 },
  thinking: { duration: 3.5, amount: 4.5 },
  searching: { duration: 1.6, amount: 5 },
  working: { duration: 1.1, amount: 2 },
  laser: { duration: 0.8, amount: 1 },
  speaking: { duration: 2.4, amount: 3.5 },
  done: { duration: 5, amount: 3 },
  failed: { duration: 5, amount: 3 },
};

/**
 * Tool names, sorted by what they make a creature LOOK like.
 *
 * Substrings rather than an enumeration, because the tool list is a connector
 * catalogue: it grows whenever someone installs something, and a state machine
 * that has to be edited per tool would be wrong within a week. An unrecognised
 * tool lands on `working`, which is both the safe answer and the true one.
 */
const LOOKS_LIKE_SEARCHING = ['search', 'find', 'list', 'query', 'lookup', 'read', 'get', 'fetch', 'browse'];

export function activityForTool(toolName: string): AgentActivity {
  const name = toolName.toLowerCase();
  return LOOKS_LIKE_SEARCHING.some(word => name.includes(word)) ? 'searching' : 'working';
}
