// The application menu template and its keyboard guard (SHORTCUTS.md §14, §15.4).
//
// What cannot run here is Electron dispatching a real key press to a real menu:
// `webContents.sendInputEvent` never reaches menu accelerators (checked in
// Electron 44), so that half is confirmed by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MenuItemConstructorOptions } from 'electron';
import { buildMenuTemplate, defaultMenuItems, parseMenuItems, shouldIgnoreMenuShortcut } from './menu.ts';
import { nativeMenuItems, resolveBindings } from '../shared/shortcuts/resolve.ts';

const flatten = (items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  items.flatMap(item => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
const roles = (items: readonly MenuItemConstructorOptions[]) =>
  flatten(items).map(item => item.role?.toLowerCase()).filter(Boolean);
const noop = () => {};

test('macOS keeps every role of Electron 44\'s default menu', () => {
  // Read from Electron at runtime with no menu set. The role menus supply their
  // own contents, so their presence covers edit, file and window items.
  const template = buildMenuTemplate('mac', defaultMenuItems('mac'), noop, 'Relayed');
  const present = roles(template);
  for (const role of [
    'about', 'services', 'hide', 'hideothers', 'unhide', 'quit',
    'filemenu', 'editmenu', 'windowmenu',
    'reload', 'forcereload', 'toggledevtools', 'resetzoom', 'zoomin', 'zoomout', 'togglefullscreen',
  ]) {
    assert.ok(present.includes(role), role);
  }
  assert.equal(template[0]?.label, 'Relayed', 'the first menu is the app menu on macOS');
});

test('Windows and Linux keep edit, view and window roles, and quit', () => {
  for (const platform of ['windows', 'linux'] as const) {
    const present = roles(buildMenuTemplate(platform, defaultMenuItems(platform), noop, 'Relayed'));
    for (const role of ['editmenu', 'windowmenu', 'quit', 'reload', 'toggledevtools', 'togglefullscreen']) {
      assert.ok(present.includes(role), `${role} on ${platform}`);
    }
  }
});

test('the Relayed items show their shortcuts, register none, and invoke by ID', () => {
  const invoked: string[] = [];
  const items = flatten(buildMenuTemplate('mac', defaultMenuItems('mac'), id => invoked.push(id), 'Relayed'))
    .filter(item => item.id?.startsWith('app.'));
  assert.deepEqual(items.map(item => [item.id, item.accelerator, item.registerAccelerator]), [
    ['app.settings.open', 'Command+,', false],
    ['app.search.open', 'Command+K', false],
    ['app.shortcuts.open', 'Command+/', false],
  ]);
  for (const item of items) (item.click as () => void)();
  assert.deepEqual(invoked, ['app.settings.open', 'app.search.open', 'app.shortcuts.open']);
});

test('a remapped or disabled binding changes the label', () => {
  const effective = resolveBindings(new Map<string, unknown>([
    ['app.search.open', [{ kind: 'chord', hotkey: 'Mod+J' }]],
    ['app.settings.open', []],
  ]), 'windows');
  const items = flatten(buildMenuTemplate('windows', nativeMenuItems(effective, 'windows'), noop, 'Relayed'));
  assert.equal(items.find(item => item.id === 'app.search.open')?.accelerator, 'Control+J');
  assert.equal(items.find(item => item.id === 'app.settings.open')?.accelerator, undefined);
});

const keyDown = (key: string, modifiers: Partial<Record<'control' | 'alt' | 'shift' | 'meta', boolean>> = {}) =>
  ({ type: 'keyDown', key, control: false, alt: false, shift: false, meta: false, ...modifiers });

test('the guard claims exactly the Relayed items\' key presses', () => {
  const items = defaultMenuItems('mac');
  assert.equal(shouldIgnoreMenuShortcut(keyDown('k', { meta: true }), 'mac', items), true);
  assert.equal(shouldIgnoreMenuShortcut(keyDown(',', { meta: true }), 'mac', items), true);
  assert.equal(shouldIgnoreMenuShortcut(keyDown('c', { meta: true }), 'mac', items), false, 'copy reaches its role');
  assert.equal(shouldIgnoreMenuShortcut(keyDown('k', { meta: true, shift: true }), 'mac', items), false, 'exact modifiers');
  assert.equal(shouldIgnoreMenuShortcut({ ...keyDown('k', { meta: true }), type: 'keyUp' }, 'mac', items), false);
});

test('the guard follows a remap, so the old chord goes back to the menu', () => {
  const effective = resolveBindings(new Map<string, unknown>([['app.search.open', [{ kind: 'chord', hotkey: 'Mod+J' }]]]), 'mac');
  const items = nativeMenuItems(effective, 'mac');
  assert.equal(shouldIgnoreMenuShortcut(keyDown('j', { meta: true }), 'mac', items), true);
  assert.equal(shouldIgnoreMenuShortcut(keyDown('k', { meta: true }), 'mac', items), false);
});

test('menu items arriving over IPC are validated', () => {
  assert.deepEqual(parseMenuItems([{ id: 'app.search.open', hotkey: 'Mod+K', accelerator: 'Command+K' }]),
    [{ id: 'app.search.open', hotkey: 'Mod+K', accelerator: 'Command+K' }]);
  for (const raw of [null, {}, [{ id: 'shell.sidebar.toggle', hotkey: null, accelerator: null }],
    [{ id: 'app.search.open', hotkey: 1, accelerator: null }], [{ id: 'toString', hotkey: null, accelerator: null }]]) {
    assert.equal(parseMenuItems(raw), null, JSON.stringify(raw));
  }
});
