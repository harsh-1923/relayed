// The only file in the app that imports @tanstack/hotkeys (SHORTCUTS.md §11).
//
// The library is alpha, so everything the rest of the app needs from it passes
// through the few functions below — an upgrade or a replacement changes this
// file and nothing else, and a boundary rule keeps it that way.
//
// Deliberately NOT re-exported: `matchesKeyboardEvent`, `HotkeyManager` and
// `useHotkey`. The matcher falls back to `event.code`, so a key that types `-`
// at the physical Slash position matches `Mod+/`, which breaks the logical-key
// contract, and it filters neither IME composition nor AltGraph. Matching is a
// lookup of `chordFromKeydown` in an index of `normalizeChord` results instead
// (spikes/hotkeys/README.md).
import {
  ALL_KEYS,
  HotkeyRecorder,
  formatForDisplay,
  formatHotkey,
  normalizeHotkey,
  normalizeHotkeyFromEvent,
  parseHotkey,
  validateHotkey,
} from '@tanstack/hotkeys';

export type Platform = 'mac' | 'windows' | 'linux';

/** The fields of a KeyboardEvent a chord is read from. Structural, so this file needs no DOM types. */
export interface KeydownLike {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

export function platformOf(nodePlatform: string): Platform {
  if (nodePlatform === 'darwin') return 'mac';
  if (nodePlatform === 'win32') return 'windows';
  return 'linux';
}

const NAMED_KEYS: ReadonlySet<string> = new Set(ALL_KEYS);

/**
 * The key a chord ends in is either one TanStack names, or the single character
 * a layout produced — `?` from Shift+/, `˚` from Option+K. The recorder emits
 * the latter, so refusing it would refuse bindings the app itself recorded.
 * `+` cannot be represented: the grammar splits on it.
 */
function isAcceptableKey(key: string): boolean {
  if (NAMED_KEYS.has(key)) return true;
  const characters = [...key];
  return characters.length === 1 && key !== '+' && !/\s/u.test(key) && !/\p{Control}/u.test(key);
}

/**
 * The canonical spelling of a chord on a platform, or null when it is not a
 * chord this app accepts.
 *
 * Stricter than `validateHotkey`, which passes `Mod+Foo` and `Mod+Shift` with
 * warnings: this also requires the final key to be named or a single produced
 * character, which a bare modifier is not.
 */
export function normalizeChord(hotkey: string, platform: Platform): string | null {
  if (typeof hotkey !== 'string' || hotkey.trim() === '') return null;
  if (!validateHotkey(hotkey).valid) return null;
  const parsed = parseHotkey(hotkey, platform);
  if (!isAcceptableKey(parsed.key)) return null;
  return normalizeHotkey(hotkey, platform);
}

/** The chord a keydown spells, in the same canonical form `normalizeChord` produces. */
export function chordFromKeydown(event: KeydownLike, platform: Platform): string {
  return normalizeHotkeyFromEvent(event as unknown as Parameters<typeof normalizeHotkeyFromEvent>[0], platform);
}

/**
 * A chord ending in the labelled physical letter key. This is opt-in per
 * command: Option changes `event.key` on macOS, while `event.code` keeps KeyB.
 */
export function physicalChordFromKeydown(event: KeydownLike, platform: Platform): string | null {
  const match = /^Key([A-Z])$/.exec(event.code ?? '');
  const physicalLetter = match?.[1];
  if (!physicalLetter) return null;
  return normalizeHotkeyFromEvent(
    { ...event, key: physicalLetter } as unknown as Parameters<typeof normalizeHotkeyFromEvent>[0],
    platform,
  );
}

/** The key and resolved modifiers of a chord on a platform (`Mod` becomes Meta or Control). */
export function parseChord(hotkey: string, platform: Platform) {
  const parsed = parseHotkey(hotkey, platform);
  return { key: parsed.key, ctrl: parsed.ctrl, alt: parsed.alt, shift: parsed.shift, meta: parsed.meta };
}

/** `⌘ ⇧ P` on macOS, `Ctrl+Shift+P` on Windows and Linux. */
export function displayChord(hotkey: string, platform: Platform): string {
  return formatForDisplay(hotkey, { platform });
}

/** A WAI-ARIA `aria-keyshortcuts` token: `Meta+K`, `Control+K`. */
export function ariaChord(hotkey: string, platform: Platform): string {
  return formatHotkey(parseHotkey(hotkey, platform));
}

const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

/**
 * Electron accelerator syntax for a chord, or null when main cannot express it.
 *
 * TanStack has no formatter for this. Only named keys convert: a produced
 * character such as `?` depends on the layout, and an accelerator would read it
 * as a different physical key, so such a chord stays renderer-owned.
 */
export function acceleratorChord(hotkey: string, platform: Platform): string | null {
  const parsed = parseHotkey(hotkey, platform);
  if (!NAMED_KEYS.has(parsed.key)) return null;
  const parts: string[] = [];
  if (parsed.ctrl) parts.push('Control');
  if (parsed.alt) parts.push('Alt');
  if (parsed.shift) parts.push('Shift');
  if (parsed.meta) parts.push(platform === 'mac' ? 'Command' : 'Super');
  parts.push(ACCELERATOR_KEYS[parsed.key] ?? parsed.key);
  return parts.join('+');
}

/**
 * TanStack's recorder, renderer-only (it listens on `document`). Re-exported
 * so the renderer's recorder hook reaches it without a second TanStack import.
 * The spike's findings apply: it listens in the capture phase and stops
 * propagation, so the command dispatcher never sees a recorded key; a bare
 * Backspace records `""`; and it ignores key presses while a text input has
 * focus, so its capture control must be a button.
 */
export { HotkeyRecorder };
