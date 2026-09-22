// Deterministic, animated avatars for agents.
//
// The root entry is pure geometry and vocabulary — no React, no DOM. The
// components live behind `@relayed/avatars/react`.
export {
  petalAvatar, PETAL_COLORS,
  type PetalAvatar, type PetalCell, type PetalOptions,
} from './geometry/petals.ts';
export {
  eyeAvatar, EYE_MOODS,
  type Eye, type EyeAvatar, type EyeMood, type EyeOptions,
} from './geometry/eyes.ts';
export {
  AGENT_ACTIVITIES, ACTIVITY_MOOD, ACTIVITY_MOTION, ACTIVITY_NOTES, activityForTool,
  type AgentActivity,
} from './activity.ts';
export { postureAt, scheduleFor, type PostureSlot } from './posture.ts';
