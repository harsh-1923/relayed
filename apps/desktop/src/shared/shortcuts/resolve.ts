// Defaults + a person's overrides -> the bindings in effect on one platform,
// and the conflicts among them (SHORTCUTS.md §8.3, §9).
//
// Pure, so the sync engine can refuse a write that would create a hard conflict
// using exactly the resolution the renderer will dispatch from.
import {
  COMMAND_IDS,
  COMMAND_LAYERS,
  definitionOf,
  isConfigurableCommandId,
  type CommandId,
  type CommandLayer,
  type NativeCommandId,
} from './catalogue.ts';
import { parseBindings } from './schema.ts';
import { acceleratorChord, normalizeChord, parseChord, type Platform } from './tanstack-driver.ts';

/**
 * Where a command's effective bindings came from.
 *
 * `invalid` is a stored row this build cannot read — a newer client's value, or
 * a corrupt one. It resolves to defaults, like `default`, but the settings page
 * can say so; the row is never rewritten, because a newer client may read it.
 */
export type BindingSource = 'default' | 'custom' | 'disabled' | 'invalid';

export interface EffectiveBinding {
  readonly id: CommandId;
  /** Canonical chords for this platform, in the order they were given. */
  readonly hotkeys: readonly string[];
  readonly source: BindingSource;
}

/** Raw decoded JSON per command, as the preference rows hold it. Absent means no row. */
export type BindingOverrides = ReadonlyMap<string, unknown>;

export function defaultHotkeys(id: CommandId, platform: Platform): string[] {
  return definitionOf(id).defaultBindings[platform].map(hotkey => {
    const chord = normalizeChord(hotkey, platform);
    // A catalogue default that does not parse is a build defect, and the
    // catalogue test fails on it before this can ship.
    if (chord === null) throw new Error(`unparseable default ${hotkey} for ${id} on ${platform}`);
    return chord;
  });
}

export function resolveBindings(overrides: BindingOverrides, platform: Platform): EffectiveBinding[] {
  return COMMAND_IDS.map(id => {
    if (!isConfigurableCommandId(id) || !overrides.has(id)) {
      return { id, hotkeys: defaultHotkeys(id, platform), source: 'default' };
    }
    const bindings = parseBindings(overrides.get(id), platform);
    if (bindings === null) return { id, hotkeys: defaultHotkeys(id, platform), source: 'invalid' };
    if (bindings.length === 0) return { id, hotkeys: [], source: 'disabled' };
    return { id, hotkeys: bindings.map(binding => binding.hotkey), source: 'custom' };
  });
}

/**
 * Layers that are live whatever has focus. Two commands here sharing a chord
 * can never both be reached, so that is a hard conflict. A focused layer —
 * an editor, an overlay, the recorder — shadowing one of them is deliberate:
 * it wins only while it has focus, and the shell command works everywhere else.
 */
const AMBIENT_LAYERS: ReadonlySet<CommandLayer> = new Set(['application', 'shell', 'workspace', 'route']);

export interface BindingConflict {
  readonly hotkey: string;
  readonly commands: readonly CommandId[];
  /** `hard` blocks a save; `shadow` is allowed and explained (§8.3). */
  readonly kind: 'hard' | 'shadow';
  /** For a shadow, the command that wins while its layer is active. */
  readonly winner?: CommandId;
}

export function findConflicts(effective: readonly EffectiveBinding[]): BindingConflict[] {
  const byChord = new Map<string, CommandId[]>();
  for (const binding of effective) {
    for (const hotkey of binding.hotkeys) {
      byChord.set(hotkey, [...(byChord.get(hotkey) ?? []), binding.id]);
    }
  }
  const conflicts: BindingConflict[] = [];
  for (const [hotkey, commands] of byChord) {
    if (commands.length < 2) continue;
    const layers = commands.map(id => definitionOf(id).layer);
    const sameLayer = new Set(layers).size < layers.length;
    const ambient = layers.filter(layer => AMBIENT_LAYERS.has(layer)).length;
    if (sameLayer || ambient > 1) {
      conflicts.push({ hotkey, commands, kind: 'hard' });
      continue;
    }
    const winner = [...commands].sort(
      (left, right) => COMMAND_LAYERS.indexOf(definitionOf(right).layer) - COMMAND_LAYERS.indexOf(definitionOf(left).layer),
    )[0];
    conflicts.push({ hotkey, commands, kind: 'shadow', ...(winner ? { winner } : {}) });
  }
  return conflicts;
}

/**
 * What main may install as native menu accelerators, converted to Electron
 * syntax (SHORTCUTS.md §12.4). Main cannot see DOM focus, so a menu command is
 * only ever `allow-editable`; the catalogue test holds that. A binding main
 * cannot express stays renderer-owned.
 */
export function nativeAccelerators(
  effective: readonly EffectiveBinding[], platform: Platform,
): { id: CommandId; accelerator: string }[] {
  const accelerators: { id: CommandId; accelerator: string }[] = [];
  for (const binding of effective) {
    if (definitionOf(binding.id).nativeMenu === false) continue;
    const [primary] = binding.hotkeys;
    const accelerator = primary === undefined ? null : acceleratorChord(primary, platform);
    if (accelerator !== null) accelerators.push({ id: binding.id, accelerator });
  }
  return accelerators;
}

/** One application-menu entry's current binding, as sync reports it to main. */
export interface NativeMenuItem {
  readonly id: NativeCommandId;
  /** The canonical chord the renderer dispatches, or null when unbound. */
  readonly hotkey: string | null;
  /** Electron accelerator syntax for display, or null when main cannot express it. */
  readonly accelerator: string | null;
}

/** Every menu command with its primary binding: what sync sends main (SHORTCUTS.md §6.3). */
export function nativeMenuItems(effective: readonly EffectiveBinding[], platform: Platform): NativeMenuItem[] {
  const accelerators = new Map(nativeAccelerators(effective, platform).map(entry => [entry.id, entry.accelerator]));
  return effective.flatMap(binding => {
    if (definitionOf(binding.id).nativeMenu === false) return [];
    return [{
      id: binding.id as NativeCommandId,
      hotkey: binding.hotkeys[0] ?? null,
      accelerator: accelerators.get(binding.id) ?? null,
    }];
  });
}

/**
 * Chords the operating system or the application menu's standard roles already
 * own (SHORTCUTS.md §4.2, §14). Binding one would either never fire or fire the
 * role as well — copy, reload, zoom — so it is refused outright rather than
 * warned about. The role chords are the ones Electron's default menu carries
 * (read from Electron 44 at runtime), which `main/menu.ts` keeps. Written in
 * any spelling and normalized here, so a list entry cannot silently miss.
 */
const EDIT_ROLES = ['Mod+A', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z', 'Mod+Shift+Z'];
const VIEW_ROLES = ['Mod+R', 'Mod+Shift+R', 'Mod+0', 'Mod+=', 'Mod+-'];
const RESERVED_SPELLINGS: Readonly<Record<Platform, readonly string[]>> = {
  mac: [
    ...EDIT_ROLES, ...VIEW_ROLES, 'Mod+Alt+Shift+V', 'Mod+Alt+I', 'Control+Meta+F',
    'Mod+Q', 'Mod+W', 'Mod+H', 'Mod+Alt+H', 'Mod+M', 'Mod+Tab', 'Mod+Space',
  ],
  windows: [...EDIT_ROLES, ...VIEW_ROLES, 'Mod+Y', 'Mod+Shift+I', 'Mod+W', 'Mod+M', 'F11', 'Alt+F4', 'Alt+Tab'],
  linux: [...EDIT_ROLES, ...VIEW_ROLES, 'Mod+Shift+I', 'Mod+W', 'Mod+M', 'F11', 'Alt+F4', 'Alt+Tab'],
};
const RESERVED: Readonly<Record<Platform, ReadonlySet<string>>> = {
  mac: reservedSet('mac'),
  windows: reservedSet('windows'),
  linux: reservedSet('linux'),
};

function reservedSet(platform: Platform): ReadonlySet<string> {
  return new Set(RESERVED_SPELLINGS[platform].map(spelling => {
    const chord = normalizeChord(spelling, platform);
    if (chord === null) throw new Error(`unparseable reserved chord ${spelling} on ${platform}`);
    return chord;
  }));
}

export type BindingProblem = 'character-only' | 'reserved';

/**
 * Why a canonical chord may not be bound to a command, or null.
 *
 * `character-only`: no Control, Alt or Meta, and not a function key. Outside a
 * focused editor that would fire while typing into anything the dispatcher does
 * not classify as editable — WCAG's character key shortcut failure (§4.4). A
 * `focused-editor` command may take one only when it is Return, with or without
 * Shift: a bare letter, Tab, Backspace or an arrow would take that key away
 * from the text being typed.
 */
export function bindingProblem(id: CommandId, hotkey: string, platform: Platform): BindingProblem | null {
  if (RESERVED[platform].has(hotkey)) return 'reserved';
  const parsed = parseChord(hotkey, platform);
  const modified = parsed.ctrl || parsed.alt || parsed.meta || /^F([1-9]|1[0-2])$/.test(parsed.key);
  if (modified) return null;
  if (definitionOf(id).inputPolicy === 'focused-editor' && parsed.key === 'Enter') return null;
  return 'character-only';
}
