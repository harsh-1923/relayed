// The command bus and the keyboard adapter's decision (SHORTCUTS.md §15.2, §15.3).
//
// Against the real registry, the real catalogue and the real binding index.
// What needs a live DOM — trusted events, the listener's lifetime under
// StrictMode, preventDefault timing — is proven in spikes/hotkeys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBindings } from '../../../shared/shortcuts/resolve.ts';
import { buildIndex, decide, type KeydownFacts } from './dispatch.ts';
import { CommandRegistry, type HandlerRegistration } from './registry.ts';

const ambiguities: unknown[] = [];
const registryOf = () => new CommandRegistry({ onAmbiguous: (...report) => ambiguities.push(report) });
const handler = (overrides: Partial<HandlerRegistration> & { calls?: string[] } = {}): HandlerRegistration => ({
  layer: 'application',
  enabled: true,
  owner: 'test',
  run: () => {},
  ...overrides,
});

// ── Registry ───────────────────────────────────────────────────────────────

test('no handler is unavailable; only disabled handlers is disabled', () => {
  const registry = registryOf();
  assert.equal(registry.execute('app.search.open'), 'unavailable');
  registry.register('app.search.open', handler({ enabled: false }));
  assert.equal(registry.execute('app.search.open'), 'disabled');
});

test('the higher layer wins whatever order the handlers registered in', () => {
  for (const order of [['shell', 'route'], ['route', 'shell']] as const) {
    const registry = registryOf();
    const calls: string[] = [];
    for (const layer of order) registry.register('shell.sidebar.toggle', handler({ layer, run: () => calls.push(layer) }));
    assert.equal(registry.execute('shell.sidebar.toggle'), 'handled');
    assert.deepEqual(calls, ['route'], order.join(' then '));
  }
});

test('a disabled higher handler falls through to an eligible lower one', () => {
  const registry = registryOf();
  const calls: string[] = [];
  registry.register('app.search.open', handler({ layer: 'overlay', enabled: false, run: () => calls.push('overlay') }));
  registry.register('app.search.open', handler({ layer: 'application', run: () => calls.push('application') }));
  registry.execute('app.search.open');
  assert.deepEqual(calls, ['application']);
});

test('two eligible handlers in one layer run neither and report both owners', () => {
  ambiguities.length = 0;
  const registry = registryOf();
  const calls: string[] = [];
  registry.register('app.search.open', handler({ owner: 'sidebar', run: () => calls.push('sidebar') }));
  registry.register('app.search.open', handler({ owner: 'title bar', run: () => calls.push('title bar') }));
  assert.equal(registry.execute('app.search.open'), 'unavailable');
  assert.deepEqual(calls, []);
  assert.deepEqual(ambiguities, [['app.search.open', 'application', ['sidebar', 'title bar']]]);
});

test('update swaps the closure without re-registering, and unregister removes', () => {
  const registry = registryOf();
  const calls: string[] = [];
  const handle = registry.register('app.search.open', handler({ run: () => calls.push('stale') }));
  handle.update({ run: () => calls.push('current') });
  registry.execute('app.search.open');
  assert.deepEqual(calls, ['current']);
  handle.unregister();
  handle.unregister();
  assert.equal(registry.execute('app.search.open'), 'unavailable');
});

test('subscribers hear availability changes, not closure swaps', () => {
  const registry = registryOf();
  let heard = 0;
  registry.subscribe(() => heard++);
  const handle = registry.register('app.search.open', handler());
  handle.update({ run: () => {} });
  handle.update({ enabled: true });
  assert.equal(heard, 1, 'register only');
  handle.update({ enabled: false });
  handle.unregister();
  assert.equal(heard, 3);
});

// ── Keyboard decision ──────────────────────────────────────────────────────

const macIndex = buildIndex(resolveBindings(new Map(), 'mac'));
const press = (key: string, facts: Partial<KeydownFacts> = {}): KeydownFacts => ({
  key, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
  repeat: false, isComposing: false, keyCode: 0, defaultPrevented: false, altGraph: false, editable: false,
  ...facts,
});
const withSearchAndSidebar = () => {
  const registry = registryOf();
  registry.register('app.search.open', handler());
  registry.register('shell.sidebar.toggle', handler({ layer: 'shell' }));
  return registry;
};

test('a bound chord with a winner runs', () => {
  const decision = decide(press('k', { metaKey: true }), 'mac', macIndex, withSearchAndSidebar());
  assert.equal(decision.kind, 'run');
  assert.equal(decision.id, 'app.search.open');
});

test('each guard skips, in the documented order', () => {
  const registry = withSearchAndSidebar();
  const cases: [KeydownFacts, string][] = [
    [press('k', { metaKey: true, defaultPrevented: true, isComposing: true }), 'default-prevented'],
    [press('k', { metaKey: true, isComposing: true }), 'composing'],
    [press('k', { metaKey: true, keyCode: 229 }), 'composing'],
    [press('k', { ctrlKey: true, altKey: true, altGraph: true }), 'altgraph'],
    [press('j', { metaKey: true }), 'unbound'],
    [press('k', { metaKey: true, shiftKey: true }), 'unbound'],
    [press('k', { metaKey: true, repeat: true }), 'repeat'],
    [press('b', { metaKey: true, editable: true }), 'editable'],
  ];
  for (const [facts, reason] of cases) {
    const decision = decide(facts, 'mac', macIndex, registry);
    assert.equal(decision.kind === 'skip' && decision.reason, reason, JSON.stringify(facts));
  }
});

test('allow-editable still runs from a text field', () => {
  assert.equal(decide(press('k', { metaKey: true, editable: true }), 'mac', macIndex, withSearchAndSidebar()).kind, 'run');
});

test('the room-panel shortcut follows the labelled B key when Option changes the produced character', () => {
  const registry = registryOf();
  registry.register('room.panels.toggle', handler({ layer: 'route' }));
  const decision = decide(press('∫', {
    code: 'KeyB', metaKey: true, altKey: true, altGraph: true, editable: true,
  }), 'mac', macIndex, registry);
  assert.equal(decision.kind, 'run');
  assert.equal(decision.id, 'room.panels.toggle');
});

test('a bound chord with no winner is left for the browser', () => {
  const registry = registryOf();
  assert.equal((decide(press('k', { metaKey: true }), 'mac', macIndex, registry) as { reason: string }).reason, 'unavailable');
  registry.register('app.search.open', handler({ enabled: false }));
  assert.equal((decide(press('k', { metaKey: true }), 'mac', macIndex, registry) as { reason: string }).reason, 'disabled');
});

test('a focused-editor command is never the document adapter\'s to dispatch', () => {
  const registry = registryOf();
  registry.register('composer.message.send', handler({ layer: 'editor' }));
  const decision = decide(press('Enter', { editable: true }), 'mac', macIndex, registry);
  assert.equal(decision.kind === 'skip' && decision.reason, 'unbound');
});

test('the index follows the platform: Control+K is search on Windows, not on mac', () => {
  const windowsIndex = buildIndex(resolveBindings(new Map(), 'windows'));
  const registry = withSearchAndSidebar();
  assert.equal(decide(press('k', { ctrlKey: true }), 'windows', windowsIndex, registry).kind, 'run');
  assert.equal(decide(press('k', { ctrlKey: true }), 'mac', macIndex, registry).kind, 'skip');
});

test('a remapped binding moves matching with it', () => {
  const index = buildIndex(resolveBindings(new Map([['app.search.open', [{ kind: 'chord', hotkey: 'Mod+P' }]]]), 'mac'));
  const registry = withSearchAndSidebar();
  assert.equal(decide(press('k', { metaKey: true }), 'mac', index, registry).kind, 'skip');
  assert.equal(decide(press('p', { metaKey: true }), 'mac', index, registry).kind, 'run');
});
