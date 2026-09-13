// The local loop end to end, with a fake runner and a real store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerOps } from '../../shared/claude.ts';
import { LocalStore } from './store.ts';
import { createLocalRooms } from './rooms.ts';

function harness(runnerDown = false) {
  const root = mkdtempSync(join(tmpdir(), 'relayed-rooms-'));
  const store = LocalStore.open(join(root, 'local-rooms.db'));
  const requests: { op: string; params: unknown }[] = [];
  const invalidated: string[][] = [];
  const streamed: { messageId: string; text: string; ui: string | null }[] = [];
  const rooms = createLocalRooms({
    store: () => store,
    runner: {
      request: <Op extends keyof RunnerOps>(op: Op, params: RunnerOps[Op]['params']) => {
        requests.push({ op, params });
        return runnerDown ? Promise.reject(new Error('the agent runner is not running')) : Promise.resolve(null as RunnerOps[Op]['result']);
      },
    },
    invalidate: topics => invalidated.push(topics),
    stream: data => streamed.push(data),
    pickFolder: () => Promise.resolve(root),
  });
  return { root, store, rooms, requests, invalidated, streamed };
}

test('create a room by choosing a folder, send, and the runner is asked to start a turn there', async () => {
  const { root, rooms, requests } = harness();
  const created = await rooms.handlers['local.rooms.create'](undefined) as { chatId: string };
  assert.equal(rooms.handlers['local.rooms.list']().length, 1);

  const sent = await rooms.handlers['local.messages.send']({ chatId: created.chatId, body: '  Why does it flake?  ' });
  assert.deepEqual(requests.at(-1), {
    op: 'turn.start',
    params: { chatId: created.chatId, messageId: sent.replyId, cwd: root, mode: 'auto', model: null, effort: null, sessionId: null, text: 'Why does it flake?' },
  });
});

test('reports become the reply: live text is pushed, parts are stored, the end is stored and counted', async () => {
  const { rooms, store, streamed } = harness();
  const { chatId } = await rooms.handlers['local.rooms.create'](undefined) as { chatId: string };
  const { replyId } = await rooms.handlers['local.messages.send']({ chatId, body: 'go' });

  rooms.onEvent({ event: 'turn.session', chatId, sessionId: 'sess-1' });
  rooms.onEvent({ event: 'turn.delta', chatId, messageId: replyId, text: 'Look', ui: null });
  assert.deepEqual(streamed.at(-1), { messageId: replyId, text: 'Look', ui: null });
  assert.equal(store.messages(chatId)[1]?.body, '', 'live text is not written');

  rooms.onEvent({ event: 'turn.parts', chatId, messageId: replyId, parts: [{ kind: 'markdown', text: 'Looking.' }] });
  assert.equal(store.messages(chatId)[1]?.body, 'Looking.');

  rooms.onEvent({ event: 'turn.done', chatId, messageId: replyId, outcome: 'completed', reason: null,
    parts: [{ kind: 'markdown', text: 'Found it.' }] });
  const reply = store.messages(chatId)[1];
  assert.deepEqual([reply?.state, reply?.body], ['acked', 'Found it.']);
  assert.deepEqual(streamed.at(-1), { messageId: replyId, text: '', ui: null }, 'the live text is cleared');
  assert.deepEqual(store.turnContext(chatId)?.sessionId, 'sess-1', 'the next message resumes this session');
});

test('a stopped turn says so', async () => {
  const { rooms, store } = harness();
  const { chatId } = await rooms.handlers['local.rooms.create'](undefined) as { chatId: string };
  const { replyId } = await rooms.handlers['local.messages.send']({ chatId, body: 'go' });
  rooms.onEvent({ event: 'turn.done', chatId, messageId: replyId, outcome: 'stopped', reason: null,
    parts: [{ kind: 'markdown', text: 'Half' }] });
  assert.deepEqual([store.messages(chatId)[1]?.state, store.messages(chatId)[1]?.body], ['failed', 'Half\n\n_Stopped._']);
});

test('A RUNNER THAT IS DOWN fails the reply at once, rather than leaving it writing for ever', async () => {
  const { rooms, store } = harness(true);
  const { chatId } = await rooms.handlers['local.rooms.create'](undefined) as { chatId: string };
  await rooms.handlers['local.messages.send']({ chatId, body: 'go' });
  const reply = store.messages(chatId)[1];
  assert.equal(reply?.state, 'failed');
  assert.match(reply?.body ?? '', /not running/);
  assert.equal(store.rooms()[0]?.busy, false, 'and the room takes the next message');
});

test('a runner that goes away mid-reply ends every reply it was writing', async () => {
  const { rooms, store } = harness();
  const { chatId } = await rooms.handlers['local.rooms.create'](undefined) as { chatId: string };
  await rooms.handlers['local.messages.send']({ chatId, body: 'go' });
  rooms.onDetach();
  assert.equal(store.messages(chatId)[1]?.state, 'failed');
});

test('cancelling the folder picker creates nothing', async () => {
  const { root } = harness();
  const store = LocalStore.open(join(root, 'second.db'));
  const rooms = createLocalRooms({
    store: () => store, runner: { request: () => Promise.resolve(null as never) },
    invalidate: () => {}, stream: () => {}, pickFolder: () => Promise.resolve(null),
  });
  assert.equal(await rooms.handlers['local.rooms.create'](undefined), null);
  assert.deepEqual(store.rooms(), []);
});

// ── modes and approvals (§8.5) ────────────────────────────────────────────

const toolAsk = (chatId: string, messageId: string, id = 'apr_1') => ({
  id, chatId, messageId, createdAt: 1, kind: 'tool' as const, toolName: 'Bash', title: 'Claude wants to run make',
  description: null, summary: 'make', input: { command: 'make' }, canAlwaysAllow: false, defaultToNo: false,
});

test('a room starts in auto; changing its mode is stored and told to the runner for its chats', async () => {
  const { rooms, requests, invalidated } = harness();
  const { spaceId, chatId } = await rooms.handlers['local.rooms.create'](undefined) as { spaceId: string; chatId: string };
  assert.equal(rooms.handlers['local.rooms.list']()[0]?.mode, 'auto');

  await rooms.handlers['local.rooms.setMode']({ spaceId, mode: 'supervised' });
  assert.equal(rooms.handlers['local.rooms.list']()[0]?.mode, 'supervised');
  assert.deepEqual(requests.at(-1), { op: 'room.mode', params: { chatIds: [chatId], mode: 'supervised' } });
  assert.ok(invalidated.at(-1)?.includes('local:rooms'));
  await assert.rejects(rooms.handlers['local.rooms.setMode']({ spaceId, mode: 'yolo' }), /room mode/);
});

test('an ask is stored and shown; answering it goes to the runner and clears it', async () => {
  const { rooms, requests, invalidated } = harness();
  const { chatId } = await rooms.handlers['local.rooms.create'](undefined) as { chatId: string };
  const { replyId } = await rooms.handlers['local.messages.send']({ chatId, body: 'build it' });

  rooms.onEvent({ event: 'approval.requested', approval: toolAsk(chatId, replyId) });
  assert.deepEqual(invalidated.at(-1), [`local:chat:${chatId}:approvals`]);
  assert.equal(rooms.handlers['local.approvals.list']({ chatId }).length, 1);

  await rooms.handlers['local.approvals.respond']({ chatId, approvalId: 'apr_1', decision: { type: 'allow' } });
  assert.deepEqual(requests.at(-1), { op: 'approval.respond', params: { chatId, approvalId: 'apr_1', decision: { type: 'allow' } } });
  assert.equal(rooms.handlers['local.approvals.list']({ chatId }).length, 0);
});

test('an ask never outlives its turn: the end of the turn, a runner going away, or a restart clears it', async () => {
  const { root, rooms, store } = harness();
  const { chatId } = await rooms.handlers['local.rooms.create'](undefined) as { chatId: string };

  const first = await rooms.handlers['local.messages.send']({ chatId, body: 'one' });
  rooms.onEvent({ event: 'approval.requested', approval: toolAsk(chatId, first.replyId) });
  rooms.onEvent({ event: 'turn.done', chatId, messageId: first.replyId, outcome: 'stopped', parts: [], reason: null });
  assert.equal(store.approvals(chatId).length, 0);

  const second = await rooms.handlers['local.messages.send']({ chatId, body: 'two' });
  rooms.onEvent({ event: 'approval.requested', approval: toolAsk(chatId, second.replyId, 'apr_2') });
  rooms.onDetach();
  assert.equal(store.approvals(chatId).length, 0);

  store.addApproval(toolAsk(chatId, second.replyId, 'apr_3'));
  store.close();
  const reopened = LocalStore.open(join(root, 'local-rooms.db'));
  assert.equal(reopened.approvals(chatId).length, 0);
  reopened.close();
});

test('a room\'s model and effort are stored, sent with the next turn, and told to live sessions', async () => {
  const { rooms, requests } = harness();
  const { spaceId, chatId } = await rooms.handlers['local.rooms.create'](undefined) as { spaceId: string; chatId: string };
  assert.deepEqual([rooms.handlers['local.rooms.list']()[0]?.model, rooms.handlers['local.rooms.list']()[0]?.effort], [null, null]);

  await rooms.handlers['local.rooms.setModel']({ spaceId, model: 'opus', effort: 'max' });
  assert.deepEqual(requests.at(-1), { op: 'room.model', params: { chatIds: [chatId], model: 'opus', effort: 'max' } });
  await rooms.handlers['local.messages.send']({ chatId, body: 'think hard' });
  assert.deepEqual(requests.at(-1)?.params, { chatId, messageId: (requests.at(-1)?.params as { messageId: string }).messageId,
    cwd: (requests.at(-1)?.params as { cwd: string }).cwd, mode: 'auto', model: 'opus', effort: 'max', sessionId: null, text: 'think hard' });

  await assert.rejects(rooms.handlers['local.rooms.setModel']({ spaceId, model: 'opus', effort: 'ludicrous' }), /effort/);
  await rooms.handlers['local.rooms.setModel']({ spaceId, model: null, effort: null });
  assert.equal(rooms.handlers['local.rooms.list']()[0]?.model, null);
});

test('the first message in a room, and only the first, is handed on for naming', async () => {
  const named: { spaceId: string; text: string }[] = [];
  const { rooms, store } = harness();
  const withNaming = createLocalRooms({
    store: () => store, runner: { request: () => Promise.resolve(null as never) },
    invalidate: () => {}, stream: () => {}, pickFolder: () => Promise.resolve(null),
    onFirstMessage: (spaceId, text) => named.push({ spaceId, text }),
  });
  const { spaceId, chatId } = await rooms.handlers['local.rooms.create'](undefined) as { spaceId: string; chatId: string };
  const first = await withNaming.handlers['local.messages.send']({ chatId, body: 'first' });
  withNaming.onEvent({ event: 'turn.done', chatId, messageId: first.replyId, outcome: 'completed', parts: [], reason: null });
  await withNaming.handlers['local.messages.send']({ chatId, body: 'second' });
  assert.deepEqual(named, [{ spaceId, text: 'first' }]);
});
