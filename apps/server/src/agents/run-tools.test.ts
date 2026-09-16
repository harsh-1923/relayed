// What a run is offered (run-tools.ts). The broker's answers are broker.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTools, toolsPrompt, CREATE_ROOM } from './run-tools.ts';

const names = (tools: ReturnType<typeof runTools>) => tools.map(tool => tool.name);

test('create_room and the messaging tools are offered to every run: no services, not in a room', () => {
  assert.deepEqual(names(runTools([], { inRoom: false })), [CREATE_ROOM, 'send_dm', 'post_message', 'add_to_room']);
  assert.deepEqual(names(runTools([{ slug: 'linear', name: 'Linear' }], { inRoom: true })),
    ['find_tools', 'call_tool', 'open_panel', CREATE_ROOM, 'send_dm', 'post_message', 'add_to_room']);
});

test('the prompt says to create a room only when asked, and last', () => {
  const prompt = toolsPrompt([], { inRoom: false });
  assert.match(prompt, /create_room/);
  assert.match(prompt, /LAST/);
  assert.match(prompt, /Never create a room nobody asked for/);
});

test('the prompt says where people\'s ids are, to message only who was asked for, and last', () => {
  const prompt = toolsPrompt([], { inRoom: false });
  assert.match(prompt, /\[Name\]\(actor:act_…\)/);
  assert.match(prompt, /Never message or add anyone the person did not ask for/);
  assert.match(prompt, /Do these LAST/);
});
