// The React entry: components, and the hook that drives their state.
//
// Separate from the package root so a consumer that only wants geometry —
// server-rendering an avatar to a PNG, say — never resolves React at all.
export { EyeAvatar } from './EyeAvatar.tsx';
export { PetalAvatar, type PetalAnimation } from './PetalAvatar.tsx';
export { useAgentPosture, type PostureInput } from './use-posture.ts';
export { usePrefersReducedMotion } from './use-reduced-motion.ts';
