// The second avatar family: a solid disc with the eyes punched out of it.
//
// Shipped: ActorAvatar draws every agent with this. /playground/avatars is
// where the knobs live.
//
// A hole, not a drawing. The eyes are cut from the disc rather than painted on
// top, so whatever is behind the avatar shows through them — which means the
// same face works on a sidebar, a hover card, and a coloured banner without
// anyone picking a matching "eye white". In SVG that is a mask, not a path with
// `fill-rule`, because a mask's children can still be animated one by one and
// an even-odd subpath cannot.
//
// Everything here is geometry at rest. The wandering, the blinking and the
// squash are the renderer's business (components/eye-avatar.css); this module
// only says where the eyes sit and what shape they are.

import { PETAL_COLORS } from './petals.ts';

/**
 * One eye, as a rounded rect. A rect covers the whole family: `r = w/2 = h/2`
 * is a circle, a squat one is a contented squint, a tall one is a wide stare.
 * One primitive means moods interpolate into each other for free.
 */
export interface Eye {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner radius. */
  r: number;
}

export type EyeMood =
  | 'neutral' | 'happy' | 'curious' | 'focused'
  | 'sleepy' | 'surprised' | 'wary' | 'playful';

export const EYE_MOODS: EyeMood[] = [
  'neutral', 'happy', 'curious', 'focused', 'sleepy', 'surprised', 'wary', 'playful',
];

/**
 * How often a seed picks each mood. NOT uniform, and that is the point: the
 * half-shut moods are the most characterful ones to look at individually and
 * the worst ones to meet in bulk — a directory where a third of the agents are
 * dozing reads as a page that failed to load, not as a cast of characters. So
 * the wide-awake shapes carry the distribution and the slits stay a garnish.
 */
const MOOD_WEIGHTS: Record<EyeMood, number> = {
  neutral: 4,
  curious: 4,
  happy: 3,
  focused: 3,
  surprised: 2,
  playful: 2,
  wary: 1,
  sleepy: 1,
};

function moodFrom(random: () => number): EyeMood {
  const total = EYE_MOODS.reduce((sum, mood) => sum + MOOD_WEIGHTS[mood], 0);
  let ticket = random() * total;
  for (const mood of EYE_MOODS) {
    ticket -= MOOD_WEIGHTS[mood];
    if (ticket <= 0) return mood;
  }
  return 'neutral';
}

export interface EyeAvatar {
  eyes: Eye[];
  color: string;
  mood: EyeMood;
  /** How far the gaze wanders, in viewBox units. */
  wander: number;
  /** Seconds between blinks. Varied per seed so a row of avatars never syncs. */
  blinkEvery: number;
  /** Phase offset in seconds, so two avatars side by side are never in step. */
  offset: number;
  size: 100;
}

export interface EyeOptions {
  /** Force a mood instead of taking one from the seed. */
  mood?: EyeMood;
  color?: string;
  /** Distance between the two eyes' centres. */
  spacing?: number;
  /** Scales every eye. */
  scale?: number;
}

const CENTRE = 50;

/**
 * Mood is entirely in the two rectangles. Asymmetry is doing most of the work:
 * a pair of identical eyes reads as a logo, and one eye a little different from
 * the other reads as a creature with an opinion.
 */
function shapesFor(mood: EyeMood): [Omit<Eye, 'x'>, Omit<Eye, 'x'>] {
  switch (mood) {
    // Tall, softly rounded — awake and not committing to anything.
    case 'neutral': return [{ y: CENTRE, w: 19, h: 28, r: 9.5 }, { y: CENTRE, w: 19, h: 28, r: 9.5 }];
    // Squat and sitting high: the shape a smiling eye makes.
    case 'happy': return [{ y: CENTRE - 3, w: 25, h: 13, r: 6.5 }, { y: CENTRE - 3, w: 25, h: 13, r: 6.5 }];
    // One eye up and wide, the other narrowed — a head tilt without a head.
    case 'curious': return [{ y: CENTRE - 3, w: 22, h: 27, r: 11 }, { y: CENTRE + 2, w: 18, h: 18, r: 9 }];
    // Small and round. Two full stops.
    case 'focused': return [{ y: CENTRE, w: 16, h: 16, r: 8 }, { y: CENTRE, w: 16, h: 16, r: 8 }];
    // Slits, low in the face.
    case 'sleepy': return [{ y: CENTRE + 5, w: 26, h: 8, r: 4 }, { y: CENTRE + 5, w: 26, h: 8, r: 4 }];
    case 'surprised': return [{ y: CENTRE, w: 28, h: 28, r: 14 }, { y: CENTRE, w: 28, h: 28, r: 14 }];
    // One held open, one half shut — suspicion.
    case 'wary': return [{ y: CENTRE - 1, w: 20, h: 26, r: 10 }, { y: CENTRE + 3, w: 23, h: 10, r: 5 }];
    // A wink: an eye and a closed line.
    case 'playful': return [{ y: CENTRE - 1, w: 20, h: 26, r: 10 }, { y: CENTRE + 3, w: 22, h: 8, r: 4 }];
  }
}

function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A stream per PURPOSE, not one stream per avatar.
 *
 * This is load-bearing. With a single sequential stream, every draw depends on
 * how many draws came before it — so supplying `mood` skipped the one call that
 * picks a mood from the seed, shifted every later draw by one, and changed the
 * COLOUR of 87% of agents the moment a state was applied. An agent went red at
 * rest and yellow while working: the same identity, repainted, which is the one
 * thing this whole approach promises never to do.
 *
 * Salting by purpose makes each property independent by construction: no option
 * can perturb a property it does not name, whatever order anything is drawn in.
 */
function streamFor(seed: string, purpose: string): () => number {
  return rng(hash(`${seed}#${purpose}`));
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

export function eyeAvatar(seed: string, options: EyeOptions = {}): EyeAvatar {
  // Identity is drawn on its own stream, so nothing a caller passes can move it.
  const identity = streamFor(seed, 'colour');
  const character = streamFor(seed, 'mood');
  const timing = streamFor(seed, 'timing');

  const mood = options.mood ?? moodFrom(character);
  const scale = options.scale ?? 1;
  const spacing = options.spacing ?? 36;
  const [left, right] = shapesFor(mood);

  const eye = (shape: Omit<Eye, 'x'>, x: number): Eye => ({
    x,
    y: shape.y,
    w: shape.w * scale,
    h: shape.h * scale,
    // Clamp, so scaling a squint never turns its corners inside out.
    r: Math.min(shape.r * scale, (shape.w * scale) / 2, (shape.h * scale) / 2),
  });

  return {
    eyes: [eye(left, CENTRE - spacing / 2), eye(right, CENTRE + spacing / 2)],
    color: options.color ?? PETAL_COLORS[Math.floor(identity() * PETAL_COLORS.length)]!,
    mood,
    wander: 3 + timing() * 2,
    blinkEvery: 4 + timing() * 4,
    offset: timing() * 4,
    size: 100,
  };
}
