// `?p=`, parsed and resolved (docs/PANELS.md §8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activePanelId, closePanelTab, formatPanelParam, panelArrivals, panelContainerToggle, parsePanelParam, resolveOpenPanels, seenPanels,
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

// ─── A synced room's shared panels arriving (panelArrivals) ─────────────────

const shared = (id: string, openedAt: number) => ({ id, openedAt, scope: 'shared' as const });
const closed = { containerOpen: false, ids: [], active: null };

test('arriving in a room with nothing open shows the most recently opened panel', () => {
  const panels = [shared('pnl_ticket', 100), shared('pnl_grafana', 300), shared('pnl_doc', 200)];
  assert.deepEqual(panelArrivals({ seen: null, panels, open: closed, dismissed: new Set() }),
    { ids: ['pnl_grafana'], active: 'pnl_grafana' });
});

test('arriving shows nothing when the link already says what is open, or the room has no panels', () => {
  const panels = [shared('pnl_ticket', 100)];
  assert.equal(panelArrivals({ seen: null, panels, open: { containerOpen: true, ids: [], active: null }, dismissed: new Set() }), null);
  assert.equal(panelArrivals({ seen: null, panels: [], open: closed, dismissed: new Set() }), null);
  assert.equal(panelArrivals({ seen: null, panels: [{ id: 'pnl_mine', openedAt: 500, scope: 'local' }], open: closed, dismissed: new Set() }), null,
    'a page only on this device is not the room\'s');
});

test('a panel this person closed is not shown again on arriving — the next most recent is', () => {
  const panels = [shared('pnl_ticket', 100), shared('pnl_grafana', 300)];
  assert.deepEqual(panelArrivals({ seen: null, panels, open: closed, dismissed: new Set(['pnl_grafana']) }),
    { ids: ['pnl_ticket'], active: 'pnl_ticket' });
});

test('a panel opened while here opens the side and is shown, when nothing was open', () => {
  const before = [shared('pnl_ticket', 100)];
  const after = [...before, shared('pnl_grafana', 300)];
  assert.deepEqual(panelArrivals({ seen: seenPanels(before), panels: after, open: closed, dismissed: new Set() }),
    { ids: ['pnl_grafana'], active: 'pnl_grafana' });
});

test('someone reading another tab keeps reading it; the new panel waits beside it', () => {
  const before = [shared('pnl_ticket', 100), shared('pnl_doc', 150)];
  const after = [...before, shared('pnl_grafana', 300)];
  const open = { containerOpen: true, ids: ['pnl_ticket', 'pnl_doc'], active: 'pnl_ticket' };
  assert.deepEqual(panelArrivals({ seen: seenPanels(before), panels: after, open, dismissed: new Set() }),
    { ids: ['pnl_ticket', 'pnl_doc', 'pnl_grafana'], active: 'pnl_ticket' });
});

test('the same page opened again is new, even for someone who closed it', () => {
  const before = [shared('pnl_ticket', 100)];
  const after = [shared('pnl_ticket', 400)];
  assert.deepEqual(panelArrivals({ seen: seenPanels(before), panels: after, open: closed, dismissed: new Set(['pnl_ticket']) }),
    { ids: ['pnl_ticket'], active: 'pnl_ticket' });
});

test('nothing new, nothing moves', () => {
  const panels = [shared('pnl_ticket', 100)];
  assert.equal(panelArrivals({ seen: seenPanels(panels), panels, open: closed, dismissed: new Set() }), null);
});
