// The eye avatar, rendered.
//
// Reached through ActorAvatar for every agent without an uploaded picture;
// /playground/avatars drives it directly to compare shapes and states.
//
// The eyes are a MASK rather than shapes drawn over the disc, so they are holes:
// the surface behind shows through them, and the same avatar sits on any
// background without anyone choosing an eye colour to match it.
import { useId, useMemo } from 'react';
import { eyeAvatar, type EyeOptions } from '../geometry/eyes.ts';
import { ACTIVITY_MOOD, type AgentActivity } from '../activity.ts';
import { classes } from './classes.ts';
import './base.css';
import './eye-avatar.css';

export function EyeAvatar({
  seed,
  activity = 'idle',
  animated = true,
  className,
  style,
  ...options
}: {
  /** An agent's handle or id — anything stable. */
  seed: string;
  /**
   * What the agent is doing. Changes the eye shape and the choreography, never
   * the colour — so the run is legible without the agent stopping being itself.
   */
  activity?: AgentActivity;
  animated?: boolean;
  className?: string;
  style?: React.CSSProperties;
} & EyeOptions) {
  const { mood, color, spacing, scale } = options;
  // An explicit mood wins over the state's; the state wins over the seed's.
  const shown = mood ?? ACTIVITY_MOOD[activity] ?? undefined;
  const avatar = useMemo(
    () => eyeAvatar(seed, {
      ...(shown !== undefined && { mood: shown }),
      ...(color !== undefined && { color }),
      ...(spacing !== undefined && { spacing }),
      ...(scale !== undefined && { scale }),
    }),
    [seed, shown, color, spacing, scale],
  );
  // Mask ids are document-global; two avatars sharing one would share a face.
  const maskId = useId();

  return (
    <svg
      viewBox="0 0 100 100"
      className={classes('relayed-avatar eye-avatar', className)}
      data-animated={animated}
      data-activity={activity}
      data-mood={avatar.mood}
      style={{
        ...style,
        '--wander': avatar.wander,
        // Co-prime-ish, so the three clocks drift apart instead of locking.
        '--gaze-duration': '7s',
        '--blink-duration': `${avatar.blinkEvery}s`,
        '--breathe-duration': '3.4s',
        '--phase': `-${avatar.offset}s`,
      } as React.CSSProperties}
      role="img"
      aria-hidden="true"
    >
      <mask id={maskId}>
        {/* White keeps the disc; the eyes are black, so they are cut away. */}
        <rect x="0" y="0" width="100" height="100" fill="white" />
        <g className="eye-gaze">
          {avatar.eyes.map((eye, i) => (
            <rect
              key={i}
              // Which side this is, so a state can move the two eyes in
              // opposite directions — convergence is what makes `laser` read
              // as aimed rather than merely small.
              data-eye={i === 0 ? 'left' : 'right'}
              // A shut eye is one whose height has already collapsed — blinking
              // it again would only make it disappear.
              className={classes('eye', eye.h <= 7 ? 'eye-shut' : undefined)}
              x={eye.x - eye.w / 2}
              y={eye.y - eye.h / 2}
              width={eye.w}
              height={eye.h}
              rx={eye.r}
              ry={eye.r}
              fill="black"
            />
          ))}
        </g>
      </mask>
      <circle className="eye-body" cx="50" cy="50" r="48" fill={avatar.color} mask={`url(#${maskId})`} />
    </svg>
  );
}

