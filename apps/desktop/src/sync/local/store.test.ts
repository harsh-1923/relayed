// Local rooms on disk (docs/LOCAL-ROOMS.md §6–§8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_AGENT, LOCAL_ME, LocalStore, RoomBusyError } from './store.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'relayed-local-'));
const open = (root = dir()) => ({ root, store: LocalStore.open(join(root, 'local-rooms.db')) });

test('a room is a directory: a space, its default chat, both members, and nothing started', () => {
  const { root, store } = open();
  const { spaceId, chatId } = store.createRoom({ cwd: root });

  const [room] = store.rooms();
  assert.equal(room?.id, spaceId);
  assert.equal(room?.cwd, root);
  assert.equal(room?.name, 'New room', 'named by what is said in it, not by the folder it already sits under');
  assert.deepEqual(room?.chats, [{ id: chatId, spaceId, kind: 'default', name: null, unread: 0, mentions: 0 }]);
  assert.equal(room?.busy, false);

  const members = store.db.prepare('SELECT actor_id, role FROM memberships WHERE scope_id = ? ORDER BY actor_id').all(spaceId);
  assert.deepEqual(members.map(row => ({ ...row })), [
    { actor_id: LOCAL_AGENT, role: 'member' }, { actor_id: LOCAL_ME, role: 'admin' },
  ]);
  assert.equal(store.turnContext(chatId)?.sessionId, null, 'no Claude Code session until the first message');
  store.close();
});

test('a room cannot be about a directory that is not there', () => {
  const { root, store } = open();
  assert.throws(() => store.createRoom({ cwd: join(root, 'missing') }), /not a directory/);
  assert.deepEqual(store.rooms(), []);
  store.close();
});

test('a composer draft survives reopen and the exact revision is consumed by send', () => {
  const root = mkdtempSync(join(tmpdir(), 'relayed-local-draft-'));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const file = join(root, 'local-rooms.db');
  const first = LocalStore.open(file);
  const { chatId } = first.createRoom({ cwd });
  first.saveDraft(chatId, '**unfinished**', 1);
  first.close();

  const reopened = LocalStore.open(file);
  assert.deepEqual(reopened.draft(chatId).map(draft => ({ body: draft.body, revision: draft.revision })), [
    { body: '**unfinished**', revision: 1 },
  ]);
  reopened.saveDraft(chatId, '**finished**', 2);
  reopened.beginTurn(chatId, '**finished**', 2);
  assert.deepEqual(reopened.draft(chatId), []);
  reopened.close();
});

test('send cannot delete a newer composer draft', () => {
  const root = mkdtempSync(join(tmpdir(), 'relayed-local-draft-race-'));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const store = LocalStore.open(join(root, 'local-rooms.db'));
  const { chatId } = store.createRoom({ cwd });
  store.saveDraft(chatId, 'newer text', 3);
  store.beginTurn(chatId, 'older snapshot', 2);
  assert.equal(store.draft(chatId)[0]?.body, 'newer text');
  store.close();
});

test('a turn is the person\'s message and a streaming reply, in order, read as replica rows', () => {
  const { root, store } = open();
  const { chatId } = store.createRoom({ cwd: root, name: 'Flaky test' });
  const { messageId, replyId } = store.beginTurn(chatId, 'Why does catchup flake?');

  const [mine, reply] = store.messages(chatId);
  assert.deepEqual([mine?.id, mine?.ord, mine?.authorType, mine?.state, mine?.body],
    [messageId, 1, 'human', 'acked', 'Why does catchup flake?']);
  assert.deepEqual([reply?.id, reply?.ord, reply?.authorType, reply?.authorName, reply?.state],
    [replyId, 2, 'agent', 'Claude Agent', 'streaming']);
  assert.equal(store.rooms()[0]?.busy, true);
  store.close();
});

test('ONE TURN PER ROOM: a second send while Claude is replying is refused', () => {
  const { root, store } = open();
  const { chatId } = store.createRoom({ cwd: root });
  store.beginTurn(chatId, 'first');
  assert.throws(() => store.beginTurn(chatId, 'second'), RoomBusyError);
  assert.equal(store.messages(chatId).length, 2, 'the refused send wrote nothing');
  store.close();
});

test('parts are replaced by snapshot while streaming, and finishing derives body', () => {
  const { root, store } = open();
  const { chatId } = store.createRoom({ cwd: root });
  const { replyId } = store.beginTurn(chatId, 'go');

  store.setStreamingParts(replyId, [{ kind: 'tool', tool_use_id: 't1', name: 'Read', ok: true, ms: 3, input: { file_path: 'a.ts' } }]);
  assert.equal(store.messages(chatId)[1]?.parts?.length, 1);

  const done = [
    { kind: 'tool', tool_use_id: 't1', name: 'Read', ok: true, ms: 3, input: { file_path: 'a.ts' } },
    { kind: 'markdown', text: 'It races the close event.' },
  ] as const;
  assert.equal(store.finishTurn(replyId, 'acked', [...done]), true);
  const reply = store.messages(chatId)[1];
  assert.equal(reply?.state, 'acked');
  assert.equal(reply?.body, '▸ Read `a.ts`\n\nIt races the close event.');
  assert.equal(store.setStreamingParts(replyId, []), false, 'a report after the end is stale and ignored');
  assert.equal(store.rooms()[0]?.busy, false);
  store.close();
});

test('A REPLY LEFT STREAMING BY A CLOSED APP is failed on the next open, keeping what it had', () => {
  const root = dir();
  const first = LocalStore.open(join(root, 'local-rooms.db'));
  const { chatId } = first.createRoom({ cwd: root });
  const { replyId } = first.beginTurn(chatId, 'go');
  first.setStreamingParts(replyId, [{ kind: 'markdown', text: 'Half an answer' }]);
  first.close();

  const second = LocalStore.open(join(root, 'local-rooms.db'));
  const reply = second.messages(chatId).find(message => message.id === replyId);
  assert.equal(reply?.state, 'failed');
  assert.match(reply?.body ?? '', /^Half an answer\n\n_Interrupted when Relayed closed\._$/);
  assert.equal(second.rooms()[0]?.busy, false, 'and the room can take a message again');
  second.close();
});

test('/clear forgets the chat\'s session and says so in the chat, but not while Claude is replying', () => {
  const { root, store } = open();
  const { chatId } = store.createRoom({ cwd: root });
  const { replyId } = store.beginTurn(chatId, 'go');
  store.setSession(chatId, 'sess-1');
  assert.throws(() => store.clearSession(chatId, 'New session.'), RoomBusyError);

  store.finishTurn(replyId, 'acked', [{ kind: 'markdown', text: 'done' }]);
  store.clearSession(chatId, '_New session._');
  assert.equal(store.turnContext(chatId)?.sessionId, null);
  const note = store.messages(chatId).at(-1);
  assert.deepEqual([note?.authorType, note?.state, note?.body], ['agent', 'acked', '_New session._']);
  store.close();
});

test('a local room reads as a space, in the replica\'s shape, with its settings apart', () => {
  const { root, store } = open();
  const { spaceId, chatId } = store.createRoom({ cwd: root, name: 'Flaky test' });

  assert.deepEqual(store.space(spaceId), {
    id: spaceId, kind: 'room', name: 'Flaky test', slug: null, visibility: 'private',
    chats: [{ id: chatId, spaceId, kind: 'default', name: null, unread: 0, mentions: 0 }],
  });
  const settings = store.roomSettings(spaceId);
  assert.deepEqual({ ...settings, lastActivityAt: 0 }, {
    spaceId, cwd: root, mode: 'auto', model: null, effort: null, busy: false, lastActivityAt: 0,
  });
  assert.equal(store.space('spc_missing'), null);
  assert.equal(store.roomSettings('spc_missing'), null);
  store.close();
});
