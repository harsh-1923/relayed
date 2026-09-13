import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_COMMANDS, parseSlashCommand, roomCommands } from './slash-commands.ts';

const command = (name: string, description = 'd') => ({ name, description, argumentHint: '', aliases: [] });

test('a message is a command only when it starts with one; the rest is its argument', () => {
  assert.deepEqual(parseSlashCommand('/compact'), { name: 'compact', args: '' });
  assert.deepEqual(parseSlashCommand('  /rename   Flaky sync test \n'), { name: 'rename', args: 'Flaky sync test' });
  assert.deepEqual(parseSlashCommand('/codex:rescue --wait fix it'), { name: 'codex:rescue', args: '--wait fix it' });
  assert.equal(parseSlashCommand('please run /compact'), null);
  assert.equal(parseSlashCommand('/'), null);
  assert.equal(parseSlashCommand('/usr/bin is a path'), null);
});

test('a room offers Claude Code\'s list without terminal-only commands, and describes the app\'s own', () => {
  const offered = roomCommands([command('compact'), command('config'), command('doctor'), command('model', 'Set the AI model'), command('deslop')]);
  assert.deepEqual(offered.map(entry => entry.name), ['compact', 'model', 'deslop']);
  assert.equal(offered[1]?.description, APP_COMMANDS.model);
});
