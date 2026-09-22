// Deterministic segment avatars: a disc cut into rounded cells, one flat colour.
//
// EXPERIMENTAL — lives behind /playground/avatars while we settle the look.
// Nothing in the app renders these yet.
//
// The mechanism is one idea: a cell is an INTERSECTION OF HALF-PLANES. The disc
// starts as a many-sided polygon (128 half-planes); every cut adds one more
// half-plane to each side of it. That buys three things a "draw arcs and
// wedges" approach does not:
//
//   - The gap and the corner rounding are the SAME operation. Shrinking a
//     half-plane is `c -= t`, so insetting a cell by `gap/2 + corner` is exact
//     and works identically for a wedge, a slab, or a sliver near the rim.
//   - Radial cuts and parallel chords are the same primitive, so the whole
//     family in the reference — halves, quadrants, slabs, petals-with-a-centre
//     — comes out of one code path instead of four.
//   - A cut is one number. Slide it and the geometry either side follows, which
//     is what makes the cuts themselves animate rather than the pieces sliding
//     about as rigid tiles (see `frames` below).
//
// The rounding itself is the stroke trick: a polygon inset by `corner` and then
// stroked at `2 * corner` with round joins is that polygon with round corners.
// So we never emit an arc; the renderer does it.

/**
 * A half-plane `nx*x + ny*y <= c`, with `(nx, ny)` a unit normal.
 *
 * `cut` ties the plane back to the cut that made it, which is what lets a phase
 * move both sides of one gap in step. The rim's planes have no cut.
 */
interface HalfPlane { nx: number; ny: number; c: number; cut?: number; sign?: 1 | -1 }

type Point = [number, number];

/** One drawable cell. */
export interface PetalCell {
  /**
   * SVG path data, one entry per animation phase — `frames[0]` is the resting
   * shape, and a single entry means the cell does not morph. Every frame has
   * the same point count, so a renderer can interpolate between them.
   */
  frames: string[];
  /** Distance from the disc centre, 0..1 — animations stagger on this. */
  depth: number;
  /**
   * Unit vector pointing away from this cell's cuts. Translating along it opens
   * the cell's own gaps, which is the cheap approximation of morphing.
   */
  drift: Point;
}

export interface PetalAvatar {
  cells: PetalCell[];
  /** Flat fill for every cell. */
  color: string;
  /** Stroke width to round the corners with: `2 * corner`. */
  stroke: number;
  /** Everything is authored in a 100x100 box. */
  size: 100;
}

export interface PetalOptions {
  /** Gap between cells, in viewBox units. */
  gap?: number;
  /** Corner rounding, in viewBox units. */
  corner?: number;
  /** How many cuts to make. Omit to let the seed decide (2..4). */
  cuts?: number;
  /** Force a fill instead of taking one from the seed. */
  color?: string;
  /**
   * Emit interpolatable geometry so the CUTS can travel. Off by default: it
   * multiplies the path data by `phases`, which only earns its cost on a
   * surface that is actually animating.
   */
  morph?: boolean;
  /** How far a cut slides, in viewBox units. */
  morphAmount?: number;
  /** Frames around one loop. Three is enough to read as continuous. */
  phases?: number;
}

// Flat, saturated, high-contrast against both themes — the reference palette.
export const PETAL_COLORS = [
  '#3b82f6', // blue
  '#ec4899', // pink
  '#16a34a', // green
  '#a855f7', // purple
  '#f97316', // orange
  '#06b6d4', // cyan
  '#eab308', // yellow
  '#ef4444', // red
] as const;

const CENTRE = 50;
const RADIUS = 48;
const CIRCLE_SIDES = 128;
/**
 * Points per emitted outline. Frames must share a point count to interpolate,
 * and clipping does not give one — a cut sliding along the rim swallows rim
 * vertices as it goes. So the outline is RESAMPLED at fixed angles instead.
 * Corner rounding smooths the facets, so this can be low.
 */
const RESAMPLE = 28;

/** FNV-1a. Any string in, one 32-bit seed out. */
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
 * Load-bearing, for the reason spelled out in eyes.ts: with one sequential
 * stream, passing `cuts` changed how many draws happened before the colour was
 * picked, so choosing a shape silently repainted the agent. Salting by purpose
 * makes each property independent by construction.
 */
function streamFor(seed: string, purpose: string): () => number {
  return rng(hash(`${seed}#${purpose}`));
}

/** mulberry32 — small, and good enough that neighbouring ids look unrelated. */
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

/** The disc, as half-planes. */
function disc(): HalfPlane[] {
  const planes: HalfPlane[] = [];
  for (let i = 0; i < CIRCLE_SIDES; i++) {
    const a = (i / CIRCLE_SIDES) * Math.PI * 2;
    const nx = Math.cos(a);
    const ny = Math.sin(a);
    planes.push({ nx, ny, c: RADIUS + nx * CENTRE + ny * CENTRE });
  }
  return planes;
}

/**
 * Clip a polygon to a half-plane (Sutherland–Hodgman). Convex in, convex out,
 * which is why the cells never need a general polygon-offset routine.
 */
function clip(poly: Point[], { nx, ny, c }: HalfPlane): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const da = nx * a[0] + ny * a[1] - c;
    const db = nx * b[0] + ny * b[1] - c;
    if (da <= 0) out.push(a);
    // Sign change means the edge crosses the boundary — add the crossing.
    if ((da <= 0) !== (db <= 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** The polygon a set of half-planes bounds, shrunk inward by `inset`. */
function polygon(planes: HalfPlane[], inset: number): Point[] {
  // A box big enough to contain the disc before any clipping happens.
  let poly: Point[] = [[-200, -200], [300, -200], [300, 300], [-200, 300]];
  for (const p of planes) {
    poly = clip(poly, { ...p, c: p.c - inset });
    if (poly.length < 3) return [];
  }
  return poly;
}

function area(poly: Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

function centroid(poly: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

/**
 * The outline, sampled at `RESAMPLE` fixed angles around `from`.
 *
 * A convex region is star-shaped from any interior point, so one ray per angle
 * hits the boundary exactly once — the distance is just the nearest half-plane
 * the ray runs into. Sampling from the RESTING centroid in every frame is what
 * makes point *i* mean the same thing across frames, and therefore what makes
 * the frames interpolate into a moving cut rather than a scramble.
 */
function outline(planes: HalfPlane[], inset: number, from: Point): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < RESAMPLE; i++) {
    const a = (i / RESAMPLE) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let t = Infinity;
    for (const p of planes) {
      const denom = p.nx * dx + p.ny * dy;
      if (denom <= 1e-9) continue; // Parallel, or facing away: never the exit.
      const hit = (p.c - inset - (p.nx * from[0] + p.ny * from[1])) / denom;
      if (hit < t) t = hit;
    }
    if (!Number.isFinite(t) || t <= 0) return [];
    points.push([from[0] + dx * t, from[1] + dy * t]);
  }
  return points;
}

function path(poly: Point[]): string {
  return `M${poly.map(p => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join('L')}Z`;
}

/**
 * Build the avatar for a seed — an agent's handle or id.
 *
 * The seed decides everything the caller does not: how many cuts, whether each
 * one runs through the centre or across as a chord, its angle, and the fill.
 */
export function petalAvatar(seed: string, options: PetalOptions = {}): PetalAvatar {
  // Identity is drawn on its own stream, so nothing a caller passes can move it.
  const identity = streamFor(seed, 'colour');
  const random = streamFor(seed, 'shape');
  const gap = options.gap ?? 3.5;
  const corner = options.corner ?? 6;
  const phases = options.morph ? Math.max(2, options.phases ?? 3) : 1;
  const amount = options.morphAmount ?? 3;

  // 2..4 cuts. One cut is allowed by the knob but never chosen by a seed: a
  // disc sliced once reads as a loading state, not a face.
  const cuts = options.cuts ?? 2 + Math.floor(random() * 3);

  // Cells are grown by splitting: every cut divides every cell it crosses.
  const baseC: number[] = [];
  const cutPhase: number[] = [];
  let cells: HalfPlane[][] = [disc()];
  for (let i = 0; i < cuts; i++) {
    // Snapped to 15 degrees. Free angles look accidental; on a grid the cuts
    // land square or on a clean diagonal, which is what makes the reference
    // read as drawn rather than shattered.
    const angle = Math.floor(random() * 12) * (Math.PI / 12);
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    // Through the centre, or offset as a chord. Chords are what make the
    // lopsided faces (a big half over two small ones) rather than pure pies.
    const offset = random() < 0.45 ? 0 : (random() * 2 - 1) * RADIUS * 0.45;
    const c = nx * CENTRE + ny * CENTRE + offset;
    baseC.push(c);
    // Each cut travels on its own clock, so the gaps never all widen at once.
    cutPhase.push(random() * Math.PI * 2);
    const next: HalfPlane[][] = [];
    for (const cell of cells) {
      next.push([...cell, { nx, ny, c, cut: i, sign: 1 }]);
      next.push([...cell, { nx: -nx, ny: -ny, c: -c, cut: i, sign: -1 }]);
    }
    cells = next;
  }

  /** The same planes, with every cut slid along its normal for this phase. */
  const atPhase = (cell: HalfPlane[], phase: number): HalfPlane[] => cell.map(p => (
    p.cut === undefined
      ? p
      : { ...p, c: p.sign! * (baseC[p.cut]! + amount * Math.sin(phase + cutPhase[p.cut]!)) }
  ));

  const inset = gap / 2 + corner;
  const drawable: PetalCell[] = [];
  for (const cell of cells) {
    const poly = polygon(cell, inset);
    // Drop slivers: a cut that grazes the rim leaves cells too small to read as
    // anything but grit once they are rounded. The threshold is generous enough
    // to keep a genuine centre dot, which is a shape we want.
    if (poly.length < 3 || area(poly) < 6) continue;
    const anchor = centroid(poly);

    const frames: string[] = [];
    for (let i = 0; i < phases; i++) {
      const planes = phases === 1 ? cell : atPhase(cell, (i / phases) * Math.PI * 2);
      const sampled = outline(planes, inset, anchor);
      // A phase that starves the cell would pop. Give up on morphing this
      // avatar rather than emitting a frame that jumps.
      if (sampled.length === 0) { frames.length = 0; break; }
      frames.push(path(sampled));
    }
    if (frames.length === 0) {
      const sampled = outline(cell, inset, anchor);
      if (sampled.length === 0) continue;
      frames.push(path(sampled));
    }

    // Away from the cuts that bound this cell — the direction that opens its
    // own gaps rather than shoving it through a neighbour.
    let dx = 0;
    let dy = 0;
    for (const p of cell) {
      if (p.cut === undefined) continue;
      dx -= p.nx;
      dy -= p.ny;
    }
    const length = Math.hypot(dx, dy) || 1;

    drawable.push({
      frames,
      depth: Math.min(1, Math.hypot(anchor[0] - CENTRE, anchor[1] - CENTRE) / RADIUS),
      drift: [dx / length, dy / length],
    });
  }

  const color = options.color
    ?? PETAL_COLORS[Math.floor(identity() * PETAL_COLORS.length)]!;

  return { cells: drawable, color, stroke: corner * 2, size: 100 };
}
