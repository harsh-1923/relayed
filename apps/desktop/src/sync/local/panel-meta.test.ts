// What a device keeps about a panel it has shown (docs/PANELS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_PANEL_MAX_AGE_MS, LocalStore } from './store.ts';
import { createLocalRooms } from './rooms.ts';
import { iconFromDataUrl, metaPatch, MAX_ICON_BYTES } from './panel-meta.ts';

const PNG = `data:image/png;base64,${Buffer.from('not really a png, but bytes').toString('base64')}`;

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'relayed-panel-meta-'));
  const store = LocalStore.open(join(root, 'local-rooms.db'));
  const { spaceId } = store.createRoom({ cwd: root });
  return { root, store, spaceId };
};

test('meta is a JSON object: a string, an array or broken JSON is refused by the table', () => {
  const { store } = setup();
  const put = (meta: string) => store.db.prepare('INSERT INTO panel_meta (panel_id, space_id, meta, updated_at) VALUES (?, ?, ?, 0)')
    .run(`pnl_${meta.length}${Math.random()}`, 'spc_1', meta);
  put('{}');
  assert.throws(() => put('"x"'), /CHECK/);
  assert.throws(() => put('[1]'), /CHECK/);
  assert.throws(() => put('{nope'), /CHECK/);
  store.close();
});

test('merging keeps fields it was not given — including ones this build does not know', () => {
  const { store, spaceId } = setup();
  store.db.prepare(`INSERT INTO panel_meta VALUES ('pnl_1', ?, '{"fromTheFuture":1}', 0)`).run(spaceId);
  assert.equal(store.mergePanelMeta('pnl_1', spaceId, { pageTitle: 'Linear' }), true);
  assert.equal(store.mergePanelMeta('pnl_1', spaceId, { iconBlob: 'a'.repeat(64) }), true);
  assert.equal(store.mergePanelMeta('pnl_1', spaceId, { pageTitle: 'Linear' }), false, 'the same report again changes nothing');
  const raw = JSON.parse((store.db.prepare("SELECT meta FROM panel_meta WHERE panel_id = 'pnl_1'").get() as { meta: string }).meta) as Record<string, unknown>;
  assert.deepEqual(raw, { fromTheFuture: 1, pageTitle: 'Linear', iconBlob: 'a'.repeat(64) });
  assert.deepEqual(store.panelMeta(spaceId), [{ panelId: 'pnl_1', meta: { pageTitle: 'Linear', iconBlob: 'a'.repeat(64) } }],
    'unknown keys are kept on disk and left out of what is read');
  store.close();
});

test('a meta row belongs to the panel id, so it outlives a replica rewriting its panels', () => {
  // A synced panel's id is not in this file at all: the row stands alone.
  const { store, spaceId } = setup();
  store.mergePanelMeta('pnl_from_server', spaceId, { pageTitle: 'Grafana' });
  store.sweepLocalPanels();
  assert.equal(store.panelMeta(spaceId).length, 1, 'a fresh row for an unknown id is not swept');
  store.sweepLocalPanels(new Set(), Date.now() + LOCAL_PANEL_MAX_AGE_MS + 1);
  assert.equal(store.panelMeta(spaceId).length, 0, 'but one unseen for as long as a local panel lives is');
  store.close();
});

test('removing a panel removes its meta', () => {
  const { store, spaceId } = setup();
  const id = store.openLocalPanel({ spaceId, type: 'web', payload: { url: 'https://linear.app/' } });
  store.mergePanelMeta(id, spaceId, { pageTitle: 'Linear' });
  store.removePanel(id);
  assert.deepEqual(store.panelMeta(spaceId), []);
  store.close();
});

test('an icon is kept only when it is a small raster data URL', () => {
  assert.ok(iconFromDataUrl(PNG));
  assert.ok(iconFromDataUrl(PNG.replace('image/png', 'image/x-icon')));
  assert.equal(iconFromDataUrl(PNG.replace('image/png', 'image/svg+xml')), null, 'no SVG');
  assert.equal(iconFromDataUrl(PNG.replace('image/png', 'text/html')), null);
  assert.equal(iconFromDataUrl('https://linear.app/favicon.ico'), null, 'a URL is not bytes');
  assert.equal(iconFromDataUrl(42), null);
  const huge = `data:image/png;base64,${Buffer.alloc(MAX_ICON_BYTES + 1).toString('base64')}`;
  assert.equal(iconFromDataUrl(huge), null);
  // Content-addressed: the same bytes, the same id, whichever page sent them.
  assert.equal(iconFromDataUrl(PNG)?.id, iconFromDataUrl(PNG)?.id);
});

test('a report stores the icon in the blob store and the title trimmed', () => {
  const stored: string[] = [];
  const patch = metaPatch({ pageTitle: '  Issue\n  ENG-42  ', icon: PNG }, id => stored.push(id));
  assert.deepEqual(patch, { pageTitle: 'Issue ENG-42', iconBlob: stored[0] });
  assert.deepEqual(metaPatch({ pageTitle: '   ', icon: 'data:text/html;base64,PGgxPg==' }, id => stored.push(id)), {});
  assert.equal(stored.length, 1);
});

test('reportMeta wakes the room only when something changed', () => {
  const { store, spaceId } = setup();
  const woken: string[][] = [];
  const blobs = new Map<string, Uint8Array>();
  const rooms = createLocalRooms({
    store: () => store, runner: { request: () => Promise.reject(new Error('unused')) },
    invalidate: topics => woken.push(topics), stream: () => {}, pickFolder: () => Promise.resolve(null),
    putBlob: (id, bytes) => blobs.set(id, bytes),
  });
  const report = (fields: Record<string, unknown>) => rooms.handlers['local.panels.reportMeta']({ panelId: 'pnl_1', spaceId, ...fields });
  report({ pageTitle: 'Linear', icon: PNG });
  report({ pageTitle: 'Linear', icon: PNG });
  report({ icon: 'data:image/svg+xml;base64,PHN2Zz4=' });
  assert.equal(woken.length, 1);
  assert.equal(blobs.size, 1);
  assert.deepEqual(Object.keys(rooms.handlers['local.panels.meta']({ spaceId })[0]!.meta).sort(), ['iconBlob', 'pageTitle']);
  store.close();
});
