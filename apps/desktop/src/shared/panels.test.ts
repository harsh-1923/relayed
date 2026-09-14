// `?p=`, parsed and resolved (docs/PANELS.md §8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activePanelId, closePanelTab, formatPanelParam, panelContainerToggle, parsePanelParam, resolveOpenPanels,
} from './panels.ts';

const panels = [
  { id: 'pnl_chat', chatId: 'cht_side' },
  { id: 'pnl_web', chatId: null },
];

test('the parameter is ids in order, without blanks or repeats', () => {
  assert.deepEqual(parsePanelParam(null), []);
  assert.deepEqual(parsePanelParam(' pnl_b, ,pnl_a,pnl_b'), ['pnl_b', 'pnl_a']);
  assert.equal(formatPanelParam(['pnl_b', 'pnl_a']), 'pnl_b,pnl_a');
});

test('ids resolve in the order given; a chat id stands for its panel; unknown ids are dropped', () => {
  assert.deepEqual(resolveOpenPanels(['pnl_web', 'cht_side', 'pnl_gone'], panels).map(p => p.id), ['pnl_web', 'pnl_chat']);
});

test('a panel named twice — once by its id, once by its chat — opens once', () => {
  assert.deepEqual(resolveOpenPanels(['cht_side', 'pnl_chat'], panels).map(p => p.id), ['pnl_chat']);
});

test('the shown tab is the one asked for when it is open, else the last opened', () => {
  assert.equal(activePanelId(['a', 'b', 'c'], 'b'), 'b');
  assert.equal(activePanelId(['a', 'b', 'c'], 'gone'), 'c');
  assert.equal(activePanelId(['a', 'b', 'c'], null), 'c');
  assert.equal(activePanelId([], 'a'), null);
});

test('closing a tab: a background tab leaves the shown one; the shown one hands over right, then left', () => {
  assert.deepEqual(closePanelTab(['a', 'b', 'c'], 'b', 'a'), { ids: ['b', 'c'], active: 'b' });
  assert.deepEqual(closePanelTab(['a', 'b', 'c'], 'b', 'b'), { ids: ['a', 'c'], active: 'c' });
  assert.deepEqual(closePanelTab(['a', 'b', 'c'], 'c', 'c'), { ids: ['a', 'b'], active: 'b' });
  assert.deepEqual(closePanelTab(['a'], 'a', 'a'), { ids: [], active: null });
  assert.deepEqual(closePanelTab(['a', 'b'], 'a', 'zzz'), { ids: ['a', 'b'], active: 'a' });
});

test('toggling the container closes an open view, reopens the newest panel, or opens the empty chooser', () => {
  assert.deepEqual(panelContainerToggle(true, panels), { kind: 'close' });
  assert.deepEqual(panelContainerToggle(false, panels), { kind: 'open', panelId: 'pnl_web' });
  assert.deepEqual(panelContainerToggle(false, []), { kind: 'open', panelId: null });
});
