// What a run is offered (run-tools.ts). The broker's answers are broker.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTools, toolsPrompt, CREATE_ROOM } from './run-tools.ts';

const names = (tools: ReturnType<typeof runTools>) => tools.map(tool => tool.name);

test('create_room is offered to every run: no services, not in a room', () => {
  assert.deepEqual(names(runTools([], { inRoom: false })), [CREATE_ROOM]);
  assert.deepEqual(names(runTools([{ slug: 'linear', name: 'Linear' }], { inRoom: true })),
    ['find_tools', 'call_tool', 'open_panel', CREATE_ROOM]);
});

test('the prompt says to create a room only when asked, and last', () => {
  const prompt = toolsPrompt([], { inRoom: false });
  assert.match(prompt, /create_room/);
  assert.match(prompt, /LAST/);
  assert.match(prompt, /Never create a room nobody asked for/);
});
