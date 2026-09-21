// Turning the shipped icon into a chosen colorway, as arithmetic.
//
// Kept separate from `app-icon.ts` because everything here is pure: bytes in,
// bytes out, no Electron. That is what lets it run under `node --test` against
// a synthetic bitmap, which matters more than usual — a bug in this file is a
// wrong-looking picture rather than an exception, and nothing else in the app
// would notice.
//
// THE SHAPES ARE NOT REDRAWN. There is no SVG rasteriser in the main process
// and adding one (resvg, sharp) would put a native module in the build for a
// single feature. Instead the shipped PNG is read back apart: its alpha IS the
// plate's coverage, and because the plate and the mark are each drawn in one
// known colour, the blend between them at every pixel can be unmixed into the
// mark's coverage. Two masks, no dependency, and antialiasing survives intact.
import {
  parseHex, SOURCE_MARK, SOURCE_PLATE, type IconColorway,
} from '../shared/icon-colorways.ts';

export interface IconMasks {
  readonly width: number;
  readonly height: number;
  /** Coverage of the rounded plate, 0..255. The source bitmap's own alpha. */
  readonly plate: Uint8Array;
  /** Coverage of the mark over that plate, 0..255. */
  readonly mark: Uint8Array;
  /** Which byte of each four holds red, green and blue (see `channelOrder`). */
  readonly order: readonly [number, number, number];
}

/** How far a sampled plate pixel may sit from the declared colour and still match. */
const CHANNEL_TOLERANCE = 2;

/**
 * Which byte of a pixel holds which channel.
 *
 * Electron documents `toBitmap()`'s layout as "platform-dependent" and leaves
 * it at that. It measures as BGRA on macOS, but a constant here would be a
 * guess about the two platforms not measured — and the guess fails as swapped
 * colours in a picture, which no test and no type would catch.
 *
 * So it is read off the image instead. The plate is drawn in one colour whose
 * three channels are all different, which makes any fully opaque plate pixel a
 * labelled sample: the byte holding 0x1D is red, 0x3F is green, 0xE0 is blue.
 */
function channelOrder(
  bitmap: Uint8Array, width: number, height: number, plate: readonly [number, number, number],
): readonly [number, number, number] | null {
  // The middle row, which crosses the plate at its widest. The first opaque
  // pixel on it is the plate's own edge, and the mark does not reach it.
  const row = Math.floor(height / 2) * width;
  for (let x = 0; x < width; x++) {
    const at = (row + x) * 4;
    if (bitmap[at + 3] !== 255) continue;
    const slots = [bitmap[at]!, bitmap[at + 1]!, bitmap[at + 2]!];
    const order = plate.map(want =>
      slots.findIndex(got => Math.abs(got - want) <= CHANNEL_TOLERANCE));
    // A permutation, or nothing. Anything else means the sample was not the
    // flat plate colour — a changed icon, or a format that is not four bytes
    // per pixel — and a half-matched order would paint the wrong colours
    // confidently.
    if (new Set(order).size === 3 && !order.includes(-1)) {
      return order as [number, number, number];
    }
    return null;
  }
  return null;
}

/**
 * Recover the plate and mark coverage from the shipped icon's pixels.
 *
 * Null when the bitmap is not the icon this was written against — a changed
 * `icon.svg`, a different size, a decode that failed. The caller leaves the
 * packaged icon alone rather than painting something wrong.
 */
export function deriveMasks(
  bitmap: Uint8Array, width: number, height: number,
): IconMasks | null {
  const count = width * height;
  if (width <= 0 || height <= 0 || bitmap.length !== count * 4) return null;

  const plateColor = parseHex(SOURCE_PLATE);
  const markColor = parseHex(SOURCE_MARK);
  if (!plateColor || !markColor) return null;

  const order = channelOrder(bitmap, width, height, plateColor);
  if (!order) return null;

  // Unmix on the channel the two colours are furthest apart on — the most
  // precision available, and the only one that cannot divide by zero where the
  // plate and the mark happen to share a channel value.
  let channel = 0;
  for (let c = 1; c < 3; c++) {
    if (Math.abs(markColor[c]! - plateColor[c]!) > Math.abs(markColor[channel]! - plateColor[channel]!)) {
      channel = c;
    }
  }
  const from = plateColor[channel]!;
  const span = markColor[channel]! - from;
  if (span === 0) return null;
  const slot = order[channel]!;

  const plate = new Uint8Array(count);
  const mark = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const alpha = bitmap[i * 4 + 3]!;
    plate[i] = alpha;
    // Only inside the plate. On its antialiased rim the colour may or may not
    // be premultiplied by alpha depending on the platform, and either way the
    // mark's coverage there is zero — so the question never has to be answered.
    if (alpha !== 255) continue;
    const ratio = (bitmap[i * 4 + slot]! - from) / span;
    mark[i] = Math.round(Math.min(1, Math.max(0, ratio)) * 255);
  }
  return { width, height, plate, mark, order };
}

/** Straight-line interpolation between two channel values. */
const mix = (from: number, to: number, amount: number): number => from + (to - from) * amount;

/**
 * Paint the masks in one colorway.
 *
 * The gradient runs corner to corner rather than by angle, which is what
 * `linear-gradient(135deg, …)` draws over a square — so the swatch in the
 * picker and the icon in the Dock are the same ramp rather than two that
 * nearly agree.
 */
export function composite(masks: IconMasks, colorway: IconColorway): Uint8Array | null {
  const from = parseHex(colorway.bg);
  const to = colorway.bg2 ? parseHex(colorway.bg2) : from;
  const markColor = parseHex(colorway.fg);
  if (!from || !to || !markColor) return null;

  const { width, height, plate, mark, order } = masks;
  const [red, green, blue] = order;
  const out = new Uint8Array(width * height * 4);
  // Guard the 1×1 case rather than dividing by zero into a NaN ramp.
  const reach = width + height - 2 || 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const alpha = plate[i]!;
      if (alpha === 0) continue;   // already transparent black
      const at = i * 4;
      const along = (x + y) / reach;
      const coverage = mark[i]! / 255;
      out[at + red] = Math.round(mix(mix(from[0], to[0], along), markColor[0], coverage));
      out[at + green] = Math.round(mix(mix(from[1], to[1], along), markColor[1], coverage));
      out[at + blue] = Math.round(mix(mix(from[2], to[2], along), markColor[2], coverage));
      out[at + 3] = alpha;
    }
  }
  return out;
}
