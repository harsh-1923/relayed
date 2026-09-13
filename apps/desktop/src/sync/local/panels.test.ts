// Panels in a local room (docs/PANELS.md §3–§5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_AGENT, LOCAL_ME, LOCAL_PANEL_MAX_AGE_MS, LocalStore } from './store.ts';

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'relayed-panels-'));
  const store = LocalStore.open(join(root, 'local-rooms.db'));
  const { spaceId, chatId } = store.createRoom({ cwd: root });
  return { root, store, spaceId, defaultChatId: chatId };
};

test('the default chat has no panel; a side chat has exactly one, made with it', () => {
  const { store, spaceId, defaultChatId } = setup();
  assert.deepEqual(store.panels(spaceId), []);

  const { chatId, panelId } = store.createChat(spaceId, { name: 'try fix B', kind: 'public' });
  const [panel] = store.panels(spaceId);
  assert.deepEqual([panel?.id, panel?.type, panel?.chatId, panel?.scope], [panelId, 'chat', chatId, 'shared']);
  assert.notEqual(panel?.chatId, defaultChatId);
  assert.equal(store.turnContext(chatId)?.sessionId, null, 'a side chat is a chat Claude can be sent to');
  store.close();
});

test('a private chat gets chat memberships; a public one derives access from the room', () => {
  const { store, spaceId } = setup();
  const pub = store.createChat(spaceId, { name: 'public', kind: 'public' });
  const priv = store.createChat(spaceId, { name: 'private', kind: 'private' });
  const rows = (chatId: string) => store.db.prepare("SELECT actor_id FROM memberships WHERE scope_type = 'chat' AND scope_id = ? ORDER BY actor_id")
    .all(chatId).map(row => row['actor_id']);
  assert.deepEqual(rows(pub.chatId), []);
  assert.deepEqual(rows(priv.chatId), [LOCAL_AGENT, LOCAL_ME]);
  store.close();
});

test('panel_chat_ref: a chat panel needs its chat, and no other type may have one — NULL cases included', () => {
  const { store, spaceId, defaultChatId } = setup();
  const insert = store.db.prepare(`
    INSERT INTO panels (id, workspace_id, space_id, type, chat_id, created_at, updated_at) VALUES (?, 'local', ?, ?, ?, 0, 0)
  `);
  assert.throws(() => insert.run('pnl_a', spaceId, 'chat', null), /CHECK/);
  assert.throws(() => insert.run('pnl_b', spaceId, 'web', defaultChatId), /CHECK/);
  assert.throws(() => insert.run('pnl_c', spaceId, 'canvas', null), /CHECK/, 'an unlisted type');
  insert.run('pnl_d', spaceId, 'web', null);
  store.close();
});

test('panel_chat: a second panel for the same chat is refused', () => {
  const { store, spaceId } = setup();
  const { chatId } = store.createChat(spaceId, { name: 'side', kind: 'public' });
  assert.throws(() => store.db.prepare(`
    INSERT INTO panels (id, workspace_id, space_id, type, chat_id, created_at, updated_at) VALUES ('pnl_x', 'local', ?, 'chat', ?, 0, 0)
  `).run(spaceId, chatId), /UNIQUE/);
  store.close();
});

test('a local panel may never be a chat panel', () => {
  const { store, spaceId } = setup();
  assert.throws(() => store.db.prepare(`
    INSERT INTO local_panels (id, space_id, type, created_at, last_opened_at) VALUES ('pnl_x', ?, 'chat', 0, 0)
  `).run(spaceId), /CHECK/);
  store.close();
});

test('deleting a chat takes its panel with it', () => {
  const { store, spaceId } = setup();
  const { chatId } = store.createChat(spaceId, { name: 'side', kind: 'private' });
  store.db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
  assert.deepEqual(store.panels(spaceId), []);
  store.close();
});

test('opening a URL makes a local panel; opening it again returns the same one', () => {
  const { store, spaceId } = setup();
  const first = store.openLocalPanel({ spaceId, type: 'web', payload: { url: 'http://localhost:5173' } }, 1_000);
  const again = store.openLocalPanel({ spaceId, type: 'web', payload: { url: 'http://localhost:5173/' } }, 2_000);
  assert.equal(again, first, 'normalised, so a trailing slash is the same page');
  const [panel] = store.panels(spaceId);
  assert.deepEqual([panel?.scope, panel?.type, panel?.payload], ['local', 'web', { url: 'http://localhost:5173/' }]);
  store.close();
});

test('a web panel opens http and https only', () => {
  const { store, spaceId } = setup();
  for (const url of ['file:///etc/passwd', 'relayed://x', 'javascript:alert(1)', 'not a url']) {
    assert.throws(() => store.openLocalPanel({ spaceId, type: 'web', payload: { url } }), /http|URL/, url);
  }
  store.close();
});

test('sharing into a local room keeps the id and moves the row; removing tombstones it', () => {
  const { store, spaceId } = setup();
  const id = store.openLocalPanel({ spaceId, type: 'web', payload: { url: 'https://example.com' } });
  store.sharePanelLocally(id);
  assert.deepEqual(store.panels(spaceId).map(p => [p.id, p.scope]), [[id, 'shared']]);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM local_panels').get()?.['n'], 0);

  store.removePanel(id);
  assert.deepEqual(store.panels(spaceId), []);
  assert.notEqual(store.db.prepare('SELECT removed_at FROM panels WHERE id = ?').get(id)?.['removed_at'], null, 'a tombstone, not a delete');
  store.close();
});

test('a chat panel cannot be removed on its own', () => {
  const { store, spaceId } = setup();
  const { panelId } = store.createChat(spaceId, { name: 'side', kind: 'public' });
  assert.throws(() => store.removePanel(panelId), /with its chat/);
  store.close();
});

test('the sweep forgets stale and orphaned local panels, but never one on screen', () => {
  const { store, spaceId } = setup();
  const now = 100 * LOCAL_PANEL_MAX_AGE_MS;
  const stale = store.openLocalPanel({ spaceId, type: 'web', payload: { url: 'https://a.test' } }, now - LOCAL_PANEL_MAX_AGE_MS - 1);
  const onScreen = store.openLocalPanel({ spaceId, type: 'web', payload: { url: 'https://b.test' } }, now - LOCAL_PANEL_MAX_AGE_MS - 1);
  const fresh = store.openLocalPanel({ spaceId, type: 'web', payload: { url: 'https://c.test' } }, now);
  const orphan = store.openLocalPanel({ spaceId: 'spc_gone', type: 'web', payload: { url: 'https://d.test' } }, now);
  const synced = store.openLocalPanel({ spaceId: 'spc_replica', workspaceId: 'wsp_1', type: 'web', payload: { url: 'https://e.test' } }, now);

  assert.equal(store.sweepLocalPanels(new Set([onScreen]), now), 2);
  const left = store.db.prepare('SELECT id FROM local_panels ORDER BY id').all().map(row => row['id']);
  assert.deepEqual(left.sort(), [onScreen, fresh, synced].sort());
  assert.ok(!left.includes(stale) && !left.includes(orphan));
  store.close();
});

test('panels are ordered by when they were made, shared and local together', () => {
  const { store, spaceId } = setup();
  const web = store.openLocalPanel({ spaceId, type: 'web', payload: { url: 'https://a.test' } }, 10);
  const { panelId } = store.createChat(spaceId, { name: 'side', kind: 'public' }, 20);
  assert.deepEqual(store.panels(spaceId).map(p => p.id), [web, panelId]);
  store.close();
});

test('the migration gives every side chat already on disk its panel, and the default chat none', async () => {
  const { openDatabase } = await import('../db.ts');
  const { migrate } = await import('../migrate.ts');
  const { localMigrations } = await import('../migrations/local.ts');
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'relayed-panels-mig-')), 'local-rooms.db'));
  migrate(db, localMigrations.filter(m => m.version < 6));
  db.exec(`
    INSERT INTO spaces (id, workspace_id, kind, name, visibility, membership_policy, created_at, updated_at)
      VALUES ('spc_1', 'local', 'room', 'r', 'private', 'invite', 0, 0);
    INSERT INTO chats (id, workspace_id, space_id, kind, name, created_at, updated_at) VALUES
      ('cht_d', 'local', 'spc_1', 'default', NULL, 0, 0),
      ('cht_p', 'local', 'spc_1', 'private', 'p', 0, 0),
      ('cht_u', 'local', 'spc_1', 'public', 'u', 0, 0);
  `);
  migrate(db, localMigrations);
  const rows = db.prepare("SELECT chat_id, type, id LIKE 'pnl_%' AS prefixed FROM panels ORDER BY chat_id").all();
  assert.deepEqual(rows.map(row => ({ ...row })), [
    { chat_id: 'cht_p', type: 'chat', prefixed: 1 }, { chat_id: 'cht_u', type: 'chat', prefixed: 1 },
  ]);
  db.close();
});
