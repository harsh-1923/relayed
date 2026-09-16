// The command catalogue: every application action a key, button, menu or
// palette may invoke, as data (SHORTCUTS.md §7, §10).
//
// Shared by every process so main and sync can validate a command ID or a
// stored binding without trusting a renderer string. No React, no DOM, no
// Electron object, and no implementation — handlers register in the renderer.
//
// IDs are durable data: a preference row is keyed by one. Rename a title freely;
// rename an ID only with a preference migration.
import type { Platform } from './tanstack-driver.ts';

/**
 * Named precedence bands, lowest first (SHORTCUTS.md §8.1). Feature code picks
 * one of these names and never a number.
 */
export const COMMAND_LAYERS = [
  'application',
  'shell',
  'workspace',
  'route',
  'editor',
  'overlay',
  'recorder',
] as const;

export type CommandLayer = (typeof COMMAND_LAYERS)[number];

export type InputPolicy = 'allow-editable' | 'deny-editable' | 'focused-editor';

/** The chords a command binds by default, per platform, in canonical spelling. */
export type PlatformBindings = Readonly<Record<Platform, readonly string[]>>;

export interface CommandDefinition {
  readonly title: string;
  readonly description: string;
  readonly category: 'Application' | 'Navigation' | 'View' | 'Composer';
  /** The layer the command's keyboard binding dispatches in; conflicts are judged by it (§8.3). */
  readonly layer: CommandLayer;
  readonly defaultBindings: PlatformBindings;
  readonly configurable: boolean;
  readonly inputPolicy: InputPolicy;
  readonly repeat: 'ignore' | 'allow';
  /** Whether matching follows the produced character or the labelled physical key. */
  readonly keyMatch: 'logical' | 'physical';
  readonly nativeMenu: false | { readonly menu: 'app' | 'view' | 'window' };
}

const everywhere = (...hotkeys: string[]): PlatformBindings =>
  ({ mac: hotkeys, windows: hotkeys, linux: hotkeys });

export const COMMANDS = {
  'app.search.open': {
    title: 'Open search',
    description: 'Search people, spaces and chats.',
    category: 'Application',
    layer: 'application',
    defaultBindings: everywhere('Mod+K'),
    configurable: true,
    inputPolicy: 'allow-editable',
    repeat: 'ignore',
    keyMatch: 'logical',
    nativeMenu: { menu: 'view' },
  },
  'shell.sidebar.toggle': {
    title: 'Toggle sidebar',
    description: 'Show or hide the sidebar.',
    category: 'View',
    layer: 'shell',
    // Denied in editable focus so the composer's bold keeps Mod+B (§10).
    defaultBindings: everywhere('Mod+B'),
    configurable: true,
    inputPolicy: 'deny-editable',
    repeat: 'ignore',
    keyMatch: 'logical',
    nativeMenu: false,
  },
  'room.panels.toggle': {
    title: 'Toggle room panels',
    description: 'Show or hide the panel container in a room.',
    category: 'View',
    layer: 'route',
    // Follows the labelled physical B key, so a keyboard layout cannot move
    // it. Mac only until the supported-platform shortcut matrix has been
    // exercised by hand. Shift rather than Option: Mod+B is the sidebar, and
    // Mod+Shift+B reads as its right-hand twin.
    defaultBindings: { mac: ['Mod+Shift+B'], windows: [], linux: [] },
    configurable: false,
    inputPolicy: 'allow-editable',
    repeat: 'ignore',
    keyMatch: 'physical',
    nativeMenu: false,
  },
  'room.panels.newTab': {
    title: 'New panel tab',
    description: 'Open a new tab in a room\'s panels, with its address bar ready to type into.',
    category: 'View',
    layer: 'route',
    defaultBindings: everywhere('Mod+T'),
    configurable: true,
    inputPolicy: 'allow-editable',
    repeat: 'ignore',
    keyMatch: 'logical',
    nativeMenu: false,
  },
  'navigation.back': {
    title: 'Navigate back',
    description: 'Go to the previous screen.',
    category: 'Navigation',
    layer: 'route',
    defaultBindings: { mac: ['Mod+['], windows: ['Alt+ArrowLeft'], linux: ['Alt+ArrowLeft'] },
    configurable: true,
    inputPolicy: 'deny-editable',
    repeat: 'ignore',
    keyMatch: 'logical',
    nativeMenu: false,
  },
  'navigation.forward': {
    title: 'Navigate forward',
    description: 'Go to the next screen.',
    category: 'Navigation',
    layer: 'route',
    defaultBindings: { mac: ['Mod+]'], windows: ['Alt+ArrowRight'], linux: ['Alt+ArrowRight'] },
    configurable: true,
    inputPolicy: 'deny-editable',
    repeat: 'ignore',
    keyMatch: 'logical',
    nativeMenu: false,
  },
  'app.settings.open': {
    title: 'Open settings',
    description: 'Open account settings.',
    category: 'Application',
    layer: 'application',
    defaultBindings: everywhere('Mod+,'),
    configurable: true,
    inputPolicy: 'allow-editable',
    repeat: 'ignore',
    keyMatch: 'logical',
    nativeMenu: { menu: 'app' },
  },
  'app.shortcuts.open': {
    title: 'Open keyboard shortcuts',
    description: 'View and change keyboard shortcuts.',
    category: 'Application',
    layer: 'application',
    defaultBindings: everywhere('Mod+/'),
    configurable: true,
    inputPolicy: 'allow-editable',
    repeat: 'ignore',
    keyMatch: 'logical',
    nativeMenu: { menu: 'view' },
  },
  'composer.message.send': {
    title: 'Send message',
    description: 'Send the message in the composer.',
    category: 'Composer',
    layer: 'editor',
    // Not symmetric: plain Enter does not send inside a code block, Mod+Enter
    // always does. That is an editor-context fact the handler owns (§10).
    defaultBindings: everywhere('Enter', 'Mod+Enter'),
    configurable: true,
    inputPolicy: 'focused-editor',
    repeat: 'ignore',
    keyMatch: 'logical',
    nativeMenu: false,
  },
} as const satisfies Record<string, CommandDefinition>;

export type CommandId = keyof typeof COMMANDS;

export const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];

export const isCommandId = (id: unknown): id is CommandId =>
  typeof id === 'string' && Object.hasOwn(COMMANDS, id);

export const definitionOf = (id: CommandId): CommandDefinition => COMMANDS[id];

/** Commands a person may rebind; the only suffixes `keybindings.<id>` accepts. */
export type ConfigurableCommandId = {
  [Id in CommandId]: (typeof COMMANDS)[Id]['configurable'] extends true ? Id : never;
}[CommandId];

export const isConfigurableCommandId = (id: unknown): id is ConfigurableCommandId =>
  isCommandId(id) && COMMANDS[id].configurable;

/** Commands main may place in the application menu; the preload allow-list. */
export type NativeCommandId = {
  [Id in CommandId]: (typeof COMMANDS)[Id]['nativeMenu'] extends false ? never : Id;
}[CommandId];

export const isNativeCommandId = (id: unknown): id is NativeCommandId =>
  isCommandId(id) && COMMANDS[id].nativeMenu !== false;
