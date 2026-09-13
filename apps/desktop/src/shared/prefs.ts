// The preference vocabulary, shared by the sync engine and the renderer.
//
// A key/value table cannot CHECK a value, so the domain lives here instead —
// and here rather than in each process for the reason `topics.ts` gives: two
// copies of a vocabulary drift, and drift between them fails silently.
//
// This file owns four facts per key, and nothing else does:
//
//   tier      which database the row lives in (PREFERENCES.md §4)
//   reach     how far it is allowed to travel (§5)
//   fallback  what it means when the row is ABSENT — defaults are never
//             written, so changing one ships with a release rather than with a
//             data migration (§7)
//   parse     what values it may hold
//
// Reads never fail: `parse` returning null — a corrupt row, a value from a
// newer client, a key that was removed — falls back. A preference is not worth
// a broken screen. Writes DO fail, in the engine, because the renderer is a
// surface and not an authority (§7).

import { isConfigurableCommandId, type ConfigurableCommandId } from './shortcuts/catalogue.ts';
import { encodeBindings } from './shortcuts/schema.ts';
import type { Platform } from './shortcuts/tanstack-driver.ts';

/** Which database holds the row. Only `account` has a writer today (§4). */
export type PreferenceTier = 'account' | 'workspace';

/**
 * How far a setting may travel. Everything is `local` today; nothing reads this
 * yet. It ships now because it has to be on rows written BEFORE sync exists, or
 * the first release that syncs cannot interpret what it finds (§5).
 */
export type PreferenceReach = 'local' | 'synced';

export interface PreferenceSpec<T> {
  readonly tier: PreferenceTier;
  readonly reach: PreferenceReach;
  readonly fallback: T;
  /** Null for anything this key cannot hold. Never throws. */
  readonly parse: (raw: unknown) => T | null;
}

const oneOf = <const T extends string>(allowed: readonly T[]) =>
  (raw: unknown): T | null =>
    typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
      ? (raw as T)
      : null;

/**
 * Every preference this app has.
 *
 * `satisfies` rather than an annotation, deliberately: an annotation would
 * widen each `fallback` to the declared type and lose the literal union, which
 * is the thing that makes `usePreference('appearance.theme')` return
 * `'system' | 'light' | 'dark'` rather than `string`.
 */
export const PREFERENCES = {
  /**
   * Light, dark, or follow the machine.
   *
   * Account-tier, so two accounts on one install each keep their own — and
   * switching accounts can therefore change the window's appearance (§4). The
   * alternative is an install-wide store, which is the table joining two
   * accounts that STORAGE.md §2 rules out.
   *
   * The three values are `nativeTheme.themeSource`'s, unchanged, because that
   * is what applies it (§9) — not a vocabulary of ours that main would have to
   * translate.
   */
  'appearance.theme': {
    tier: 'account',
    reach: 'local',
    fallback: 'system',
    parse: oneOf(['system', 'light', 'dark']),
  },
} as const satisfies Record<string, PreferenceSpec<unknown>>;

export type PreferenceKey = keyof typeof PREFERENCES;

/**
 * The value type of one key, narrowed to its literal union where it has one.
 *
 * Read off `parse` rather than off `fallback`, which is the whole domain rather
 * than the one member of it the default happens to be. Taking it from the
 * fallback types `appearance.theme` as `'system'`, and the compiler then
 * rejects the control that offers the other two — loudly, which is the only
 * reason this is a footnote rather than a bug.
 */
export type PreferenceValue<K extends PreferenceKey> =
  NonNullable<ReturnType<(typeof PREFERENCES)[K]['parse']>>;

export type ThemePreference = PreferenceValue<'appearance.theme'>;

/** One row as it is stored. `value` is JSON TEXT, not a decoded value. */
export interface PreferenceRow {
  key: string;
  value: string;
  reach: PreferenceReach;
}

export const isPreferenceKey = (key: string): key is PreferenceKey =>
  Object.hasOwn(PREFERENCES, key);

/**
 * A person's bindings for one command (SHORTCUTS.md §9.2).
 *
 * A DERIVED family rather than seven entries above: the suffix must be a
 * configurable command in the command catalogue, so the vocabulary stays closed
 * without being restated. Kept out of `PreferenceKey`, whose value types are
 * read off `parse` — a binding list is decoded by the shortcut resolver against
 * the reading platform, never by `decode`.
 */
export const KEYBINDING_PREFIX = 'keybindings.';

export type KeybindingKey = `keybindings.${ConfigurableCommandId}`;

export const isKeybindingKey = (key: string): key is KeybindingKey =>
  typeof key === 'string' && key.startsWith(KEYBINDING_PREFIX) && isConfigurableCommandId(key.slice(KEYBINDING_PREFIX.length));

export const keybindingKey = (id: ConfigurableCommandId): KeybindingKey => `${KEYBINDING_PREFIX}${id}`;

/** Every key the engine will write: the fixed catalogue and the keybinding family. */
export const isWritablePreferenceKey = (key: string): key is PreferenceKey | KeybindingKey =>
  typeof key === 'string' && (isPreferenceKey(key) || isKeybindingKey(key));

export const specOf = <K extends PreferenceKey>(key: K): PreferenceSpec<PreferenceValue<K>> =>
  PREFERENCES[key] as unknown as PreferenceSpec<PreferenceValue<K>>;

/**
 * Decode one key out of the rows the engine returned.
 *
 * Every failure lands on the fallback, and they are all ordinary rather than
 * exceptional: no row at all is the common case (defaults are not written), a
 * value this build cannot parse is what a downgrade looks like, and invalid
 * JSON is a row the CHECK should have stopped but a corrupt file would not.
 */
export function decode<K extends PreferenceKey>(
  key: K, rows: readonly PreferenceRow[] | null,
): PreferenceValue<K> {
  const spec = specOf(key);
  const row = rows?.find(r => r.key === key);
  if (!row) return spec.fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(row.value);
  } catch {
    return spec.fallback;
  }
  return spec.parse(raw) ?? spec.fallback;
}

/**
 * Validate and encode a value for storage, or throw.
 *
 * The engine's gate. Both failures are programmer errors rather than user ones
 * — a surface offering a value the catalogue does not allow, or a key that does
 * not exist — so they are loud.
 */
export function encode(
  key: string, value: unknown, platform?: Platform,
): { value: string; reach: PreferenceReach } {
  if (isKeybindingKey(key)) {
    // Canonical for the WRITING platform — the spelling its recorder produces.
    // Required rather than defaulted: a guessed platform would store `Mod+K`
    // where the person meant Control on a Mac.
    if (!platform) throw new Error(`a platform is required to encode ${key}`);
    return { value: encodeBindings(value, platform), reach: 'local' };
  }
  if (!isPreferenceKey(key)) throw new Error(`unknown preference: ${key}`);
  const spec = specOf(key);
  if (spec.parse(value) === null) {
    throw new Error(`invalid value for ${key}: ${JSON.stringify(value)}`);
  }
  // JSON text, always — `"dark"` and not `dark`. The table's json_valid() CHECK
  // rejects the bare spelling, which is the single mistake this line can make.
  return { value: JSON.stringify(value), reach: spec.reach };
}
