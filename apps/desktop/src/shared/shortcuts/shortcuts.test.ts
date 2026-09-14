// The shared command contract (SHORTCUTS.md §15.1).
//
// Catalogue-wide properties are checked by iterating the catalogue, so a new
// command is covered by being added rather than by somebody remembering to
// test it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMAND_IDS,
  COMMANDS,
  isCommandId,
  isConfigurableCommandId,
  isNativeCommandId,
} from './catalogue.ts';
import { encodeBindings, parseBindings } from './schema.ts';
import { bindingProblem, defaultHotkeys, findConflicts, nativeAccelerators, resolveBindings } from './resolve.ts';
import {
  acceleratorChord,
  ariaChord,
  chordFromKeydown,
  displayChord,
  normalizeChord,
  parseChord,
  platformOf,
  type Platform,
} from './tanstack-driver.ts';

const PLATFORMS: readonly Platform[] = ['mac', 'windows', 'linux'];
const PUNCTUATION = new Set(['/', '[', ']', '\\', '=', '-', ',', '.', ';', '`']);
const chord = (hotkey: string) => ({ kind: 'chord', hotkey });

// ── Catalogue ──────────────────────────────────────────────────────────────

test('command IDs are a reviewed snapshot', () => {
  // IDs are durable preference keys. Changing this list is a migration, not a rename.
  assert.deepEqual(COMMAND_IDS, [
    'app.search.open',
    'shell.sidebar.toggle',
    'room.panels.toggle',
    'navigation.back',
    'navigation.forward',
    'app.settings.open',
    'app.shortcuts.open',
    'composer.message.send',
  ]);
});

test('every default parses on every platform and is already canonical', () => {
  for (const id of COMMAND_IDS) {
    for (const platform of PLATFORMS) {
      for (const hotkey of COMMANDS[id].defaultBindings[platform]) {
        assert.equal(normalizeChord(hotkey, platform), hotkey, `${id} ${hotkey} on ${platform}`);
      }
    }
  }
});

test('the defaults have no hard conflict on any platform', () => {
  for (const platform of PLATFORMS) {
    const hard = findConflicts(resolveBindings(new Map(), platform)).filter(conflict => conflict.kind === 'hard');
    assert.deepEqual(hard, [], platform);
  }
});

test('no default combines Shift with punctuation, which reports the shifted character', () => {
  // Trusted Cmd+Shift+/ arrives as key "?" (spikes/hotkeys), so Mod+Shift+/ never matches.
  for (const id of COMMAND_IDS) {
    for (const platform of PLATFORMS) {
      for (const hotkey of defaultHotkeys(id, platform)) {
        const parsed = parseChord(hotkey, platform);
        assert.ok(!(parsed.shift && PUNCTUATION.has(parsed.key)), `${id} ${hotkey} on ${platform}`);
      }
    }
  }
});

test('a macOS default combining Alt with a letter explicitly follows the physical key', () => {
  for (const id of COMMAND_IDS) {
    for (const hotkey of defaultHotkeys(id, 'mac')) {
      const parsed = parseChord(hotkey, 'mac');
      if (parsed.alt && /^[A-Z]$/.test(parsed.key)) assert.equal(COMMANDS[id].keyMatch, 'physical', `${id} ${hotkey}`);
    }
  }
});

test('a character-only default is confined to a focused component', () => {
  // WCAG character key shortcuts: an unmodified key must be remappable, disableable,
  // or active only while its component has focus (§4.4).
  for (const id of COMMAND_IDS) {
    for (const platform of PLATFORMS) {
      for (const hotkey of defaultHotkeys(id, platform)) {
        const parsed = parseChord(hotkey, platform);
        if (parsed.ctrl || parsed.alt || parsed.meta) continue;
        assert.equal(COMMANDS[id].inputPolicy, 'focused-editor', `${id} ${hotkey}`);
      }
    }
  }
});

test('a native menu command is safe in every focus context', () => {
  // Main installs its accelerator and cannot see DOM focus, so it could not honour a deny.
  for (const id of COMMAND_IDS) {
    if (COMMANDS[id].nativeMenu === false) continue;
    assert.equal(COMMANDS[id].inputPolicy, 'allow-editable', id);
  }
});

test('the ID guards accept exactly their families', () => {
  assert.ok(isCommandId('app.search.open'));
  assert.ok(!isCommandId('app.search'));
  assert.ok(!isCommandId('toString'), 'not fooled by the prototype');
  assert.ok(isConfigurableCommandId('shell.sidebar.toggle'));
  assert.ok(isNativeCommandId('app.settings.open'));
  assert.ok(!isNativeCommandId('shell.sidebar.toggle'));
});

// ── Driver ─────────────────────────────────────────────────────────────────

test('aliases normalize to one index key per platform', () => {
  assert.equal(normalizeChord('Cmd+k', 'mac'), 'Mod+K');
  assert.equal(normalizeChord('Meta+K', 'mac'), 'Mod+K');
  assert.equal(normalizeChord('Control+K', 'windows'), 'Mod+K');
  assert.equal(normalizeChord('ctrl+k', 'linux'), 'Mod+K');
  assert.equal(normalizeChord('Shift+Mod+P', 'mac'), 'Mod+Shift+P');
  assert.equal(normalizeChord('Ctrl+K', 'mac'), 'Control+K', 'Control is not Mod on mac');
});

test('normalizeChord refuses what validateHotkey lets through', () => {
  for (const hotkey of ['', '   ', 'Mod+', 'Mod+Shift', 'Mod+Foo', 'Mod++', 'Mod+ab']) {
    assert.equal(normalizeChord(hotkey, 'mac'), null, JSON.stringify(hotkey));
  }
});

test('a character the layout produced is a valid key, because the recorder emits it', () => {
  assert.equal(normalizeChord('Mod+Shift+?', 'mac'), 'Mod+Shift+?');
  assert.equal(normalizeChord('Alt+˚', 'mac'), 'Alt+˚');
});

test('a keydown reads to the same canonical chord, and exact modifiers matter', () => {
  const event = (key: string, modifiers: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) =>
    ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers });
  assert.equal(chordFromKeydown(event('k', { metaKey: true }), 'mac'), 'Mod+K');
  assert.equal(chordFromKeydown(event('k', { ctrlKey: true }), 'windows'), 'Mod+K');
  assert.equal(chordFromKeydown(event('K', { metaKey: true, shiftKey: true }), 'mac'), 'Mod+Shift+K');
  assert.equal(chordFromKeydown(event('?', { metaKey: true, shiftKey: true }), 'mac'), 'Mod+Shift+?');
  // Logical key only: `-` at the physical Slash position is not Mod+/.
  assert.equal(chordFromKeydown(event('-', { metaKey: true }), 'mac'), 'Mod+-');
});

test('display, ARIA and accelerator projections of one chord', () => {
  assert.equal(displayChord('Mod+Shift+P', 'mac'), '⌘ ⇧ P');
  assert.equal(displayChord('Mod+Shift+P', 'windows'), 'Ctrl+Shift+P');
  assert.equal(ariaChord('Mod+K', 'mac'), 'Meta+K');
  assert.equal(ariaChord('Mod+K', 'linux'), 'Control+K');
  assert.equal(acceleratorChord('Mod+K', 'mac'), 'Command+K');
  assert.equal(acceleratorChord('Mod+K', 'windows'), 'Control+K');
  assert.equal(acceleratorChord('Alt+ArrowLeft', 'linux'), 'Alt+Left');
  assert.equal(acceleratorChord('Mod+,', 'mac'), 'Command+,');
  assert.equal(acceleratorChord('Mod+Shift+?', 'mac'), null, 'a produced character is layout-dependent');
});

test('platformOf maps Node platforms', () => {
  assert.equal(platformOf('darwin'), 'mac');
  assert.equal(platformOf('win32'), 'windows');
  assert.equal(platformOf('linux'), 'linux');
});

// ── Schema ─────────────────────────────────────────────────────────────────

test('a stored list parses to canonical chords', () => {
  assert.deepEqual(parseBindings([chord('Cmd+Shift+p')], 'mac'), [chord('Mod+Shift+P')]);
  assert.deepEqual(parseBindings([], 'mac'), [], 'empty is disabled, not invalid');
});

test('every unreadable value parses to null rather than throwing', () => {
  const unreadable: unknown[] = [
    null, 'Mod+K', {}, [null], ['Mod+K'],
    [{ kind: 'sequence', steps: ['G', 'D'] }],
    [{ kind: 'chord' }],
    [{ kind: 'chord', hotkey: 'Mod+K', when: 'editor' }],
    [chord('Mod+Shift')],
    [chord('Mod+K'), chord('Cmd+K')],
    [chord('Mod+1'), chord('Mod+2'), chord('Mod+3'), chord('Mod+4'), chord('Mod+5')],
  ];
  for (const value of unreadable) {
    assert.equal(parseBindings(value, 'mac'), null, JSON.stringify(value));
  }
});

test('encodeBindings writes canonical JSON and refuses what parse refuses', () => {
  assert.equal(encodeBindings([chord('Control+J')], 'windows'), '[{"kind":"chord","hotkey":"Mod+J"}]');
  assert.throws(() => encodeBindings([chord('Mod+')], 'mac'), /invalid keybindings/);
});

// ── Resolution ─────────────────────────────────────────────────────────────

const effectiveOf = (overrides: Record<string, unknown>, platform: Platform = 'mac') =>
  Object.fromEntries(resolveBindings(new Map(Object.entries(overrides)), platform).map(binding => [binding.id, binding]));

test('missing, custom, disabled and unreadable overrides resolve as specified', () => {
  const effective = effectiveOf({
    'app.search.open': [chord('Mod+P')],
    'shell.sidebar.toggle': [],
    'navigation.back': [{ kind: 'sequence', steps: ['G', 'B'] }],
  });
  assert.deepEqual(effective['app.search.open'], { id: 'app.search.open', hotkeys: ['Mod+P'], source: 'custom' });
  assert.deepEqual(effective['shell.sidebar.toggle'], { id: 'shell.sidebar.toggle', hotkeys: [], source: 'disabled' });
  assert.deepEqual(effective['navigation.back'], { id: 'navigation.back', hotkeys: ['Mod+['], source: 'invalid' });
  assert.deepEqual(effective['app.settings.open'], { id: 'app.settings.open', hotkeys: ['Mod+,'], source: 'default' });
});

test('defaults are chosen per platform', () => {
  assert.deepEqual(effectiveOf({}, 'windows')['navigation.back']?.hotkeys, ['Alt+ArrowLeft']);
});

test('an override for an unknown command is ignored, not an error', () => {
  const effective = resolveBindings(new Map([['app.teleport', [chord('Mod+T')]]]), 'mac');
  assert.equal(effective.length, COMMAND_IDS.length);
});

test('two ambient commands sharing a chord is a hard conflict', () => {
  const conflicts = findConflicts(resolveBindings(new Map([['shell.sidebar.toggle', [chord('Mod+K')]]]), 'mac'));
  assert.deepEqual(conflicts, [{ hotkey: 'Mod+K', commands: ['app.search.open', 'shell.sidebar.toggle'], kind: 'hard' }]);
});

test('a focused layer over an ambient one is a shadow, and the focused command wins', () => {
  const conflicts = findConflicts(resolveBindings(new Map([['composer.message.send', [chord('Mod+K')]]]), 'mac'));
  assert.deepEqual(conflicts, [{
    hotkey: 'Mod+K',
    commands: ['app.search.open', 'composer.message.send'],
    kind: 'shadow',
    winner: 'composer.message.send',
  }]);
});

test('aliases spelled differently still collide', () => {
  const conflicts = findConflicts(resolveBindings(new Map([['app.settings.open', [chord('Meta+K')]]]), 'mac'));
  assert.equal(conflicts[0]?.kind, 'hard');
});

test('native accelerators: menu commands only, from the primary binding', () => {
  const accelerators = nativeAccelerators(resolveBindings(new Map(), 'mac'), 'mac');
  assert.deepEqual(accelerators, [
    { id: 'app.search.open', accelerator: 'Command+K' },
    { id: 'app.settings.open', accelerator: 'Command+,' },
    { id: 'app.shortcuts.open', accelerator: 'Command+/' },
  ]);
  const disabled = nativeAccelerators(resolveBindings(new Map([['app.search.open', []]]), 'windows'), 'windows');
  assert.ok(!disabled.some(entry => entry.id === 'app.search.open'), 'a disabled command has no accelerator');
});

test('no default is refused by the rules a person\'s binding must pass', () => {
  for (const id of COMMAND_IDS) {
    for (const platform of PLATFORMS) {
      for (const hotkey of defaultHotkeys(id, platform)) {
        assert.equal(bindingProblem(id, hotkey, platform), null, `${id} ${hotkey} on ${platform}`);
      }
    }
  }
});

test('reserved and character-only chords are named', () => {
  assert.equal(bindingProblem('app.search.open', 'Mod+C', 'mac'), 'reserved');
  assert.equal(bindingProblem('app.search.open', 'Alt+F4', 'windows'), 'reserved');
  assert.equal(bindingProblem('app.search.open', 'Mod+R', 'mac'), 'reserved', 'the View menu reload role');
  assert.equal(bindingProblem('app.search.open', 'Control+Meta+F', 'mac'), 'reserved', 'normalized, not string-matched');
  assert.equal(bindingProblem('app.search.open', 'J', 'mac'), 'character-only');
  assert.equal(bindingProblem('app.search.open', 'Shift+J', 'mac'), 'character-only');
  assert.equal(bindingProblem('app.search.open', 'F2', 'mac'), null, 'a function key is not typing');
  assert.equal(bindingProblem('composer.message.send', 'Enter', 'mac'), null, 'a focused editor may take Return');
  assert.equal(bindingProblem('composer.message.send', 'Shift+Enter', 'mac'), null);
  assert.equal(bindingProblem('composer.message.send', 'J', 'mac'), 'character-only', 'but not a letter');
  assert.equal(bindingProblem('composer.message.send', 'Tab', 'mac'), 'character-only', 'nor a navigation key');
  assert.equal(bindingProblem('app.search.open', 'Mod+J', 'mac'), null);
});
