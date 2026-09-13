// The persisted shape of a person's bindings for one command (SHORTCUTS.md §9.1).
//
//   key    = keybindings.app.search.open
//   value  = [{"kind":"chord","hotkey":"Mod+K"}]
//
// An ordered replacement list, not a patch. An empty list means disabled; no
// row means defaults. The object wrapper leaves a tagged place for a future
// `sequence` kind without reinterpreting old strings.
//
// Like the preference catalogue, this is asymmetric: `parseBindings` returns
// null rather than throwing, because a read falls back; `encodeBindings` throws,
// because a write carrying a bad value is a programmer error.
import { normalizeChord, type Platform } from './tanstack-driver.ts';

export interface ChordBinding {
  readonly kind: 'chord';
  readonly hotkey: string;
}

export type Binding = ChordBinding;

/** More than this is a recording loop, not a person's choice. */
export const MAX_BINDINGS_PER_COMMAND = 4;

/**
 * The bindings a stored value holds, or null when this build cannot read it.
 *
 * Null covers every way a value can be unreadable: not an array, an unknown
 * `kind` (what a newer client's `sequence` looks like), an extra property, a
 * chord this platform cannot parse, a duplicate, or too many.
 *
 * `platform` is the one reading. A chord is accepted in any spelling the
 * platform normalizes — `Control+K` written on Windows is `Mod+K` there — and
 * returned canonical, so the index and conflict checks compare like with like.
 */
export function parseBindings(raw: unknown, platform: Platform): Binding[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_BINDINGS_PER_COMMAND) return null;
  const bindings: Binding[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('hotkey')) return null;
    const { kind, hotkey } = entry as { kind: unknown; hotkey: unknown };
    if (kind !== 'chord' || typeof hotkey !== 'string') return null;
    const chord = normalizeChord(hotkey, platform);
    if (chord === null || seen.has(chord)) return null;
    seen.add(chord);
    bindings.push({ kind: 'chord', hotkey: chord });
  }
  return bindings;
}

/**
 * Validate a list for storage, or throw. Stored canonical for the writing
 * platform, which is what the recorder produces anyway.
 */
export function encodeBindings(value: unknown, platform: Platform): string {
  const bindings = parseBindings(value, platform);
  if (bindings === null) throw new Error(`invalid keybindings: ${JSON.stringify(value)}`);
  return JSON.stringify(bindings);
}
