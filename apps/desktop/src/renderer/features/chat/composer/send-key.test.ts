// The composer's send decision against the bus's bindings (SHORTCUTS.md §15.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSendKey, type SendKeyContext } from './send-key.ts';

const context = (overrides: Partial<SendKeyContext> = {}): SendKeyContext => ({
  platform: 'mac', hotkeys: ['Enter', 'Mod+Enter'], suggestionOpen: false, inCodeBlock: false, ...overrides,
});
const press = (key: string, modifiers: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing', boolean>> = {}) =>
  ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, keyCode: 13, ...modifiers });

test('with the defaults, Return and Cmd+Return send, Shift+Return does not', () => {
  assert.equal(isSendKey(press('Enter'), context()), true);
  assert.equal(isSendKey(press('Enter', { metaKey: true }), context()), true);
  assert.equal(isSendKey(press('Enter', { shiftKey: true }), context()), false);
});

test('inside a code block Return is a newline and Cmd+Return still sends', () => {
  assert.equal(isSendKey(press('Enter'), context({ inCodeBlock: true })), false);
  assert.equal(isSendKey(press('Enter', { metaKey: true }), context({ inCodeBlock: true })), true);
});

test('an open suggestion menu owns Return, even a modified one', () => {
  assert.equal(isSendKey(press('Enter'), context({ suggestionOpen: true })), false);
  assert.equal(isSendKey(press('Enter', { metaKey: true }), context({ suggestionOpen: true })), false);
});

test('composition never sends', () => {
  assert.equal(isSendKey(press('Enter', { isComposing: true }), context()), false);
  assert.equal(isSendKey({ ...press('Enter'), keyCode: 229 }, context()), false);
});

test('a remap is what sends: Cmd+Return only leaves plain Return as a newline', () => {
  const remapped = context({ hotkeys: ['Mod+Enter'] });
  assert.equal(isSendKey(press('Enter'), remapped), false);
  assert.equal(isSendKey(press('Enter', { metaKey: true }), remapped), true);
});

test('disabled sends from no key, and modifiers match exactly', () => {
  assert.equal(isSendKey(press('Enter', { metaKey: true }), context({ hotkeys: [] })), false);
  assert.equal(isSendKey(press('Enter', { ctrlKey: true }), context()), false, 'Control is not Mod on mac');
  assert.equal(isSendKey(press('Enter', { ctrlKey: true }), context({ platform: 'windows' })), true);
  assert.equal(isSendKey(press('Enter', { altKey: true }), context()), false);
});

test('a Shift+Return binding sends outside code and is a newline inside it', () => {
  const shifted = context({ hotkeys: ['Shift+Enter'] });
  assert.equal(isSendKey(press('Enter', { shiftKey: true }), shifted), true);
  assert.equal(isSendKey(press('Enter', { shiftKey: true }), { ...shifted, inCodeBlock: true }), false);
  assert.equal(isSendKey(press('Enter'), shifted), false);
});
