// The icon compositor (main/app-icon.ts explains why it works this way).
//
// Worth testing in more than usual detail, because every failure mode here is
// a picture that looks wrong rather than an exception: swapped channels, a
// mark that did not separate from its plate, a gradient running the wrong way.
// Nothing downstream would notice any of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composite, deriveMasks, type IconMasks } from './icon-composite.ts';
import {
  colorwayOf, DEFAULT_ICON_COLORWAY_ID, ICON_COLORWAYS, parseHex, SOURCE_MARK, SOURCE_PLATE,
} from '../shared/icon-colorways.ts';

const PLATE = parseHex(SOURCE_PLATE)!;
const MARK = parseHex(SOURCE_MARK)!;

/** BGRA, as macOS measures; the RGBA case is covered by its own test below. */
const BGRA = [2, 1, 0] as const;

/**
 * A miniature of the shipped icon: a transparent border, a plate, a 2x2 mark,
 * and one pixel half-covered by it so antialiasing has something to survive.
 */
function syntheticIcon(order: readonly [number, number, number] = BGRA): {
  bitmap: Uint8Array; width: number; height: number;
} {
  const width = 8, height = 8;
  const bitmap = new Uint8Array(width * height * 4);
  const put = (x: number, y: number, rgb: readonly number[], alpha: number) => {
    const at = (y * width + x) * 4;
    bitmap[at + order[0]] = rgb[0]!;
    bitmap[at + order[1]] = rgb[1]!;
    bitmap[at + order[2]] = rgb[2]!;
    bitmap[at + 3] = alpha;
  };
  const blend = (amount: number) => PLATE.map((from, i) => Math.round(from + (MARK[i]! - from) * amount));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      if (edge) put(x, y, PLATE, 0);
      else if (x >= 3 && x <= 4 && y >= 3 && y <= 4) put(x, y, MARK, 255);
      else if (x === 2 && y === 4) put(x, y, blend(0.5), 255);
      else put(x, y, PLATE, 255);
    }
  }
  return { bitmap, width, height };
}

const at = (masks: IconMasks, x: number, y: number) => y * masks.width + x;

test('the two coverage masks come back out of the shipped colours', () => {
  const { bitmap, width, height } = syntheticIcon();
  const masks = deriveMasks(bitmap, width, height);
  assert.ok(masks);

  assert.deepEqual([...masks.order], [...BGRA]);
  assert.equal(masks.plate[at(masks, 0, 0)], 0, 'the border is outside the plate');
  assert.equal(masks.plate[at(masks, 1, 4)], 255, 'the plate is fully covered');
  assert.equal(masks.mark[at(masks, 1, 4)], 0, 'plate alone carries no mark');
  assert.equal(masks.mark[at(masks, 3, 3)], 255, 'the mark is fully covered');
  // The whole point of unmixing rather than thresholding: a pixel the mark
  // only half covers stays half covered, which is what keeps its edges smooth.
  assert.equal(masks.mark[at(masks, 2, 4)], 128, 'antialiasing survives');
});

test('the channel order is read off the image, not assumed', () => {
  // The same icon laid out RGBA. Electron documents toBitmap()'s order as
  // platform-dependent, so a build that flipped it must still paint correctly
  // rather than swapping every colorway's red and blue.
  const rgba = [0, 1, 2] as const;
  const { bitmap, width, height } = syntheticIcon(rgba);
  const masks = deriveMasks(bitmap, width, height);
  assert.ok(masks);
  assert.deepEqual([...masks.order], [...rgba]);
  assert.equal(masks.mark[at(masks, 3, 3)], 255);
});

test('a bitmap that is not this icon is refused rather than guessed at', () => {
  const { bitmap, width, height } = syntheticIcon();
  assert.equal(deriveMasks(bitmap, width, height + 1), null, 'wrong dimensions');
  assert.equal(deriveMasks(new Uint8Array(0), 0, 0), null, 'empty');

  // A plate drawn in some other colour: the mark can no longer be separated
  // from it, so the caller must keep the shipped icon instead of compositing
  // mush. This is the check that catches an icon.svg edited without touching
  // SOURCE_PLATE.
  const recoloured = Uint8Array.from(bitmap);
  for (let i = 0; i < width * height; i++) {
    if (recoloured[i * 4 + 3] === 0) continue;
    recoloured[i * 4] = 7; recoloured[i * 4 + 1] = 7; recoloured[i * 4 + 2] = 7;
  }
  assert.equal(deriveMasks(recoloured, width, height), null, 'a different plate colour');
});

test('a flat colorway paints its plate and its mark, and nothing else', () => {
  const { bitmap, width, height } = syntheticIcon();
  const masks = deriveMasks(bitmap, width, height)!;
  const ink = colorwayOf('ink');
  const pixels = composite(masks, ink)!;
  assert.ok(pixels);

  const read = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return [pixels[i + masks.order[0]], pixels[i + masks.order[1]], pixels[i + masks.order[2]], pixels[i + 3]];
  };
  assert.deepEqual(read(1, 4), [...parseHex(ink.bg)!, 255], 'the plate');
  assert.deepEqual(read(3, 3), [...parseHex(ink.fg)!, 255], 'the mark');
  assert.deepEqual(read(0, 0), [0, 0, 0, 0], 'outside stays transparent');
});

test('a gradient colorway runs corner to corner', () => {
  // Hand-built rather than derived, so both ends of the ramp are on a pixel
  // the plate actually covers.
  const masks: IconMasks = {
    width: 2, height: 1, order: BGRA,
    plate: Uint8Array.from([255, 255]),
    mark: Uint8Array.from([0, 0]),
  };
  const pixels = composite(masks, {
    id: 'ramp', name: 'Ramp', bg: '#000000', bg2: '#FFFFFF', fg: '#FF0000',
  })!;
  assert.equal(pixels[BGRA[0]], 0, 'starts at bg');
  assert.equal(pixels[4 + BGRA[0]], 255, 'ends at bg2');
});

test('the mark wins over the gradient underneath it', () => {
  const masks: IconMasks = {
    width: 2, height: 1, order: BGRA,
    plate: Uint8Array.from([255, 255]),
    mark: Uint8Array.from([0, 255]),
  };
  const pixels = composite(masks, {
    id: 'ramp', name: 'Ramp', bg: '#000000', bg2: '#FFFFFF', fg: '#123456',
  })!;
  const fg = parseHex('#123456')!;
  assert.deepEqual(
    [pixels[4 + BGRA[0]], pixels[4 + BGRA[1]], pixels[4 + BGRA[2]]],
    [...fg],
    'full coverage is the mark colour exactly, not a blend with the ramp',
  );
});

test('the default colorway is the icon that ships', () => {
  // If these drift, a fresh install shows one picture in Finder and a
  // different one in the Dock the moment the app starts — and the compositor
  // would refuse to run at all, since these are the colours it unmixes against.
  const fallback = colorwayOf(DEFAULT_ICON_COLORWAY_ID);
  assert.equal(fallback.bg.toUpperCase(), SOURCE_PLATE.toUpperCase());
  assert.equal(fallback.fg.toUpperCase(), SOURCE_MARK.toUpperCase());
  assert.equal(fallback.bg2, undefined, 'the shipped plate is flat');
});

test('every colorway is a distinct id in colours the compositor can parse', () => {
  const ids = new Set<string>();
  for (const colorway of ICON_COLORWAYS) {
    assert.equal(ids.has(colorway.id), false, `duplicate id: ${colorway.id}`);
    ids.add(colorway.id);
    for (const hex of [colorway.bg, colorway.fg, ...(colorway.bg2 ? [colorway.bg2] : [])]) {
      assert.ok(parseHex(hex), `${colorway.id} has an unparseable colour: ${hex}`);
    }
  }
});

test('an unknown id resolves to the default rather than throwing', () => {
  // What a row written by a newer client, or left by a removed colorway, looks
  // like on the way to `app.dock.setIcon`.
  assert.equal(colorwayOf('not-a-colorway').id, DEFAULT_ICON_COLORWAY_ID);
});
