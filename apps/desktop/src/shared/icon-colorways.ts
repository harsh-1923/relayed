// The app icon's colorways, shared by the compositor and the surfaces.
//
// Shared for the reason `topics.ts` and `prefs.ts` are: main composites the
// dock icon from these values and the renderer paints both the picker and the
// in-app mark from them, and two copies of a vocabulary drift.
//
// A CLOSED list, with an id per entry, and the ID is what is stored. Storing
// the three colours instead would read better the day somebody wants a custom
// one, but it breaks the rule PREFERENCES.md §3 is built on: a client that
// meets a value it does not understand has to fall back to something sensible.
// An id it cannot resolve falls back to the default icon; three hexes it cannot
// judge would paint an unreadable one. A custom-colour key can arrive later
// beside this one without disturbing it.

export interface IconColorway {
  readonly id: string;
  readonly name: string;
  /** The plate colour, or the start of its gradient. */
  readonly bg: string;
  /** The end of the plate's gradient, top-left to bottom-right. Absent is flat. */
  readonly bg2?: string;
  /** The mark, over the plate. */
  readonly fg: string;
}

/**
 * The two colours the shipped icon is actually drawn in (`resources/icon.svg`).
 *
 * NOT decoration. `main/app-icon.ts` recovers its two coverage masks by
 * unmixing every pixel of the shipped PNG against this pair, so changing
 * icon.svg's fills without changing these stops the mark being separable from
 * its plate. `loadMasks` re-derives them from the file and refuses to composite
 * if they disagree, rather than painting mush.
 */
export const SOURCE_PLATE = '#1D3FE0';
export const SOURCE_MARK = '#FFFFFF';

/**
 * Twelve, not the hundred in the colorway study.
 *
 * The study is a tool for choosing a brand; this is a preference someone scans
 * once. The two gradients are in deliberately — they are the only entries that
 * exercise the compositor's interpolation path, so a build that broke it would
 * show up in the picker rather than in whichever install had chosen one.
 */
const CATALOGUE = [
  // FIRST, AND EQUAL TO THE SOURCE PAIR ABOVE. This is what the packaged
  // .icns already contains, so the default colorway and the icon a fresh
  // install shows in Finder are the same picture.
  { id: 'cobalt',     name: 'Cobalt',     bg: '#1D3FE0', fg: '#FFFFFF' },
  { id: 'ink',        name: 'Ink',        bg: '#16130F', fg: '#F4EFE4' },
  { id: 'bone',       name: 'Bone',       bg: '#F4EFE4', fg: '#16130F' },
  { id: 'emerald',    name: 'Emerald',    bg: '#0B3B2E', fg: '#EAF3EE' },
  { id: 'oxblood',    name: 'Oxblood',    bg: '#3B0F13', fg: '#F1E1E0' },
  { id: 'aubergine',  name: 'Aubergine',  bg: '#2D1830', fg: '#EDE0EE' },
  { id: 'tangerine',  name: 'Tangerine',  bg: '#FF6A1F', fg: '#1A0800' },
  { id: 'chartreuse', name: 'Chartreuse', bg: '#C6F51B', fg: '#171A05' },
  { id: 'fuchsia',    name: 'Fuchsia',    bg: '#E0148C', fg: '#FFFFFF' },
  { id: 'clay',       name: 'Clay',       bg: '#B5502E', fg: '#FFFFFF' },
  { id: 'dawn',       name: 'Dawn',       bg: '#FFB6A3', bg2: '#7A5CFA', fg: '#1A1024' },
  { id: 'aurora',     name: 'Aurora',     bg: '#0B3B2E', bg2: '#12D6E0', fg: '#FFFFFF' },
] as const satisfies readonly IconColorway[];

export type IconColorwayId = (typeof CATALOGUE)[number]['id'];

/**
 * An entry, with its id still narrowed to the literal.
 *
 * `as const` above also narrows every OTHER field, which makes the array a
 * union of twelve object types — and `bg2` then does not exist on the nine
 * without a gradient, so iterating it cannot read one. Widening to
 * `IconColorway` fixes that and loses the ids, which a surface needs to write
 * the preference back. This keeps the half that is load-bearing.
 */
export type CataloguedColorway = IconColorway & { readonly id: IconColorwayId };

export const ICON_COLORWAYS: readonly CataloguedColorway[] = CATALOGUE;

/** The domain `appearance.icon` parses against. */
export const ICON_COLORWAY_IDS: readonly IconColorwayId[] =
  CATALOGUE.map(colorway => colorway.id);

export const DEFAULT_ICON_COLORWAY_ID: IconColorwayId = 'cobalt';

const BY_ID = new Map<string, IconColorway>(
  CATALOGUE.map(colorway => [colorway.id, colorway]),
);

/**
 * Resolve an id, falling back rather than throwing.
 *
 * Every caller is painting something. An id from a newer client, or one a
 * release removed, is an ordinary event here for the same reason it is in
 * `decode` — a preference is not worth a broken screen, or in this case a
 * missing dock icon.
 */
export function colorwayOf(id: string): IconColorway {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_ICON_COLORWAY_ID)!;
}

/** `#RRGGBB` to its three channels. Null for anything that is not one. */
export function parseHex(hex: string): readonly [number, number, number] | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** The CSS the renderer paints a swatch with. Matches the compositor's 135° ramp. */
export function colorwayBackground(colorway: IconColorway): string {
  return colorway.bg2
    ? `linear-gradient(135deg, ${colorway.bg}, ${colorway.bg2})`
    : colorway.bg;
}
