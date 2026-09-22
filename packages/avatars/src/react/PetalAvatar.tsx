// The experimental segment avatar, rendered.
//
// EXPERIMENTAL — only /playground/avatars uses this. The eye family is what
// ActorAvatar draws; this one is still a candidate, kept for comparison.
//
// Local and synchronous: the SVG is computed from the seed on render, so it
// needs no network, no blob, and no cache. That is the whole argument for
// generating rather than fetching a hosted avatar.
import { useMemo } from 'react';
import { petalAvatar, type PetalOptions } from '../geometry/petals.ts';
import { usePrefersReducedMotion } from './use-reduced-motion.ts';
import { ACTIVITY_MOTION, type AgentActivity } from '../activity.ts';
import { classes } from './classes.ts';
import './base.css';
import './petal-avatar.css';

/**
 * `morph` is the only one that moves the CUTS — the geometry is regenerated per
 * frame with each gap slid along its own normal, and the browser interpolates
 * between them. The others transform finished cells, which is cheaper but can
 * only ever shuffle rigid tiles about.
 */
export type PetalAnimation = 'none' | 'morph' | 'flow' | 'breathe' | 'orbit' | 'spin';

export function PetalAvatar({
  seed,
  activity = 'idle',
  animation = 'morph',
  duration,
  className,
  background,
  style,
  ...options
}: {
  /** An agent's handle or id — anything stable. */
  seed: string;
  /**
   * What the agent is doing. With no eyes to narrow, this family has only pace
   * and travel to say it with — so a state reads here as how hard the cuts are
   * working, not as an expression.
   */
  activity?: AgentActivity;
  animation?: PetalAnimation;
  /** Seconds for one cycle. Overrides whatever the activity asked for. */
  duration?: number;
  className?: string;
  /** Disc backing, if the surface wants one. Transparent by default. */
  background?: string;
  style?: React.CSSProperties;
} & Omit<PetalOptions, 'morph'>) {
  const { gap, corner, cuts, color, morphAmount, phases } = options;
  const motion = ACTIVITY_MOTION[activity];
  const cycle = duration ?? motion.duration;
  const travel = morphAmount ?? motion.amount;
  // SMIL ignores stylesheets, so the reduced-motion media query cannot stop the
  // morph. Not generating it is the only switch there is — and it saves the
  // extra frames of path data too. Read unconditionally: `&&` would skip the
  // hook whenever the animation is not a morph.
  const reduced = usePrefersReducedMotion();
  const morph = animation === 'morph' && !reduced;
  const avatar = useMemo(
    () => petalAvatar(seed, {
      morph,
      ...(gap !== undefined && { gap }),
      ...(corner !== undefined && { corner }),
      ...(cuts !== undefined && { cuts }),
      ...(color !== undefined && { color }),
      morphAmount: travel,
      ...(phases !== undefined && { phases }),
    }),
    [seed, morph, gap, corner, cuts, color, travel, phases],
  );

  return (
    <svg
      viewBox="0 0 100 100"
      className={classes('relayed-avatar', className)}
      data-activity={activity}
      style={{ ...style, '--petal-duration': `${cycle}s` } as React.CSSProperties}
      role="img"
      aria-hidden="true"
    >
      {background && <circle cx="50" cy="50" r="50" fill={background} />}
      <g className={animation === 'spin' ? 'petal-anim-spin' : `petal-anim-${animation}`}>
        {avatar.cells.map((cell, i) => (
          <path
            key={i}
            className="petal-cell"
            d={cell.frames[0]}
            fill={avatar.color}
            stroke={avatar.color}
            strokeWidth={avatar.stroke}
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{
              // Which way this cell has to move to open its OWN gaps. The
              // direction is per-cell, so it has to reach CSS as a variable.
              '--petal-fx': `${cell.drift[0].toFixed(3)}px`,
              '--petal-fy': `${cell.drift[1].toFixed(3)}px`,
              // Stagger on depth, so anything periodic reads as one wave
              // leaving the centre rather than every segment twitching at once.
              ...(animation !== 'none' && animation !== 'spin' && {
                animationDelay: `${(-cell.depth * cycle) / 2}s`,
              }),
            } as React.CSSProperties}
          >
            {/* SMIL rather than CSS: `d` interpolation needs the frames as a
                value list, and every frame here shares a point count by
                construction (see RESAMPLE in petals.ts). The cells run on
                staggered offsets, so the cuts travel rather than pulse. */}
            {morph && cell.frames.length > 1 && (
              <animate
                attributeName="d"
                dur={`${cycle}s`}
                repeatCount="indefinite"
                calcMode="spline"
                keySplines={cell.frames.map(() => '0.45 0 0.55 1').join(';')}
                keyTimes={cell.frames.map((_, f) => (f / cell.frames.length).toFixed(4)).concat('1').join(';')}
                values={cell.frames.concat(cell.frames[0]!).join(';')}
                begin={`${(-cell.depth * cycle) / 3}s`}
              />
            )}
          </path>
        ))}
      </g>
    </svg>
  );
}
