// The application menu (SHORTCUTS.md §14).
//
// Pure: the template and the keyboard guard are functions of the platform and
// the menu items' effective bindings, so `node --test` checks both without
// Electron. `index.ts` owns the Electron objects.
//
// WHAT IT REPLACES. Without `Menu.setApplicationMenu` Electron installs its
// default menu, and on macOS that menu is what makes copy, paste and undo work
// in a text field. Calling setApplicationMenu discards it wholesale, so every
// role it carried is kept here. Read from Electron 44 at runtime, the default
// is: App (about, services, hide, hide others, show all, quit), File (close),
// Edit (undo … select all, substitutions, speech), View (reload, force reload,
// developer tools, zoom, full screen) and Window (minimize, zoom, bring all to
// front). The role menus are used as roles wherever nothing is added to them,
// so Electron keeps supplying their contents.
//
// ONE KEYBOARD OWNER. The renderer's command bus owns every Relayed shortcut:
// it applies layers, editable focus and remapping, none of which main can see.
// The menu only DISPLAYS a Relayed item's shortcut. On Windows and Linux,
// `registerAccelerator: false` says exactly that. macOS always registers a
// menu accelerator, so `shouldIgnoreMenuShortcut` runs in `before-input-event`
// and suppresses menu shortcuts for the one key press that matches a Relayed
// item — the documented use of `setIgnoreMenuShortcuts`. Roles are untouched:
// they never match, so copy and paste still reach the menu.
import type { MenuItemConstructorOptions } from 'electron';
import type { NativeCommandId } from '../shared/shortcuts/catalogue.ts';
import { nativeMenuItems, resolveBindings, type NativeMenuItem } from '../shared/shortcuts/resolve.ts';
import { chordFromKeydown, type Platform } from '../shared/shortcuts/tanstack-driver.ts';

export type { NativeMenuItem };

/** Defaults, for the menu main builds before sync has opened an account. */
export const defaultMenuItems = (platform: Platform): NativeMenuItem[] =>
  nativeMenuItems(resolveBindings(new Map(), platform), platform);

/** Menu labels: the catalogue title, with the ellipsis a settings window takes by convention. */
const LABELS: Record<NativeCommandId, string> = {
  'app.search.open': 'Search',
  'app.settings.open': 'Settings…',
  'app.shortcuts.open': 'Keyboard Shortcuts',
};

export function buildMenuTemplate(
  platform: Platform,
  items: readonly NativeMenuItem[],
  invoke: (id: NativeCommandId) => void,
  appName: string,
): MenuItemConstructorOptions[] {
  const entry = (id: NativeCommandId): MenuItemConstructorOptions => {
    const item = items.find(candidate => candidate.id === id);
    return {
      id,
      label: LABELS[id],
      ...(item?.accelerator ? { accelerator: item.accelerator } : {}),
      // Display only; the renderer owns the key (see the header).
      registerAccelerator: false,
      click: () => invoke(id),
    };
  };
  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      entry('app.search.open'),
      entry('app.shortcuts.open'),
      { type: 'separator' },
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  if (platform === 'mac') {
    return [
      {
        label: appName,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          entry('app.settings.open'),
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      view,
      { role: 'windowMenu' },
    ];
  }
  return [
    { label: 'File', submenu: [entry('app.settings.open'), { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    view,
    { role: 'windowMenu' },
  ];
}

/** The fields of Electron's `before-input-event` input the guard reads. */
export interface MenuInput {
  readonly type: string;
  readonly key: string;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

/**
 * Whether this key press is a Relayed menu item's shortcut, so the menu must
 * not act on it and the renderer's bus is its only owner.
 *
 * Matched the way the renderer matches — the logical key through the same
 * driver — so the two cannot disagree about which press is which.
 */
export function shouldIgnoreMenuShortcut(input: MenuInput, platform: Platform, items: readonly NativeMenuItem[]): boolean {
  if (input.type !== 'keyDown') return false;
  const chord = chordFromKeydown({
    key: input.key, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift, metaKey: input.meta,
  }, platform);
  return items.some(item => item.hotkey === chord);
}

/** Refuses anything but a well-formed item list, since it arrives over IPC. */
export function parseMenuItems(raw: unknown): NativeMenuItem[] | null {
  if (!Array.isArray(raw)) return null;
  const items: NativeMenuItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { id, hotkey, accelerator } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !Object.hasOwn(LABELS, id)) return null;
    if (hotkey !== null && typeof hotkey !== 'string') return null;
    if (accelerator !== null && typeof accelerator !== 'string') return null;
    items.push({ id: id as NativeCommandId, hotkey, accelerator });
  }
  return items;
}
