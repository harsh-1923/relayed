// A room's slash commands: asked once per folder, never waited on, replaced by a live session's push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeCommand } from '../../shared/claude.ts';
import { LocalStore } from './store.ts';
import { createLocalCommands } from './commands.ts';

const command = (name: string): ClaudeCommand => ({ name, description: name, argumentHint: '', aliases: [] });
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(answer: () => Promise<ClaudeCommand[]>) {
  const root = mkdtempSync(join(tmpdir(), 'relayed-commands-'));
  const store = LocalStore.open(join(root, 'local-rooms.db'));
  const asked: string[] = [];
  const invalidated: string[][] = [];
  let clock = 0;
  const commands = createLocalCommands({
    store: () => store,
    runner: { request: (_op, { cwd }) => { asked.push(cwd); return answer(); } },
    invalidate: topics => invalidated.push(topics),
    now: () => clock,
  });
  const { chatId } = store.createRoom({ cwd: root });
  return { root, store, commands, chatId, asked, invalidated, tick: (ms: number) => { clock += ms; } };
}

test('the first read asks for the folder and returns nothing yet; the answer wakes readers, filtered', async () => {
  const { commands, chatId, root, asked, invalidated } = harness(() => Promise.resolve([command('compact'), command('config')]));
  assert.deepEqual(commands.handlers['local.commands.list']({ chatId }), []);
  assert.deepEqual(commands.handlers['local.commands.list']({ chatId }), [], 'a second read does not ask again');
  assert.deepEqual(asked, [root]);
  await settle();
  assert.deepEqual(invalidated, [['local:commands']]);
  assert.deepEqual(commands.handlers['local.commands.list']({ chatId }).map(entry => entry.name), ['compact']);
});

test('a stale list is asked for again; a live session\'s push replaces it at once', async () => {
  const { commands, chatId, asked, tick } = harness(() => Promise.resolve([command('compact')]));
  commands.handlers['local.commands.list']({ chatId });
  await settle();
  tick(6 * 60_000);
  commands.handlers['local.commands.list']({ chatId });
  assert.equal(asked.length, 2);
  await settle();

  commands.onEvent({ event: 'commands.changed', chatId, commands: [command('compact'), command('new-skill')] });
  assert.deepEqual(commands.handlers['local.commands.list']({ chatId }).map(entry => entry.name), ['compact', 'new-skill']);
});

test('a folder Claude Code cannot start in offers no commands, and a chat that is not local offers none', async () => {
  const { commands, chatId } = harness(() => Promise.reject(new Error('not signed in')));
  commands.handlers['local.commands.list']({ chatId });
  await settle();
  assert.deepEqual(commands.handlers['local.commands.list']({ chatId }), []);
  assert.deepEqual(commands.handlers['local.commands.list']({ chatId: 'cht_elsewhere' }), []);
});
