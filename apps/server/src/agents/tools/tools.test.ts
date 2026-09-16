// What a run is offered (run-tools.ts). The broker's answers are broker.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTools, toolsPrompt, CREATE_ROOM, WRITE_ROOM_SUMMARY, READ_ROOM_SUMMARY } from './index.ts';

/** Every run that is not Roomkeeping's, which is every run but one agent's. */
const anyone = { isRoomkeeper: false };

const names = (tools: ReturnType<typeof runTools>) => tools.map(tool => tool.name);

test('create_room and the messaging tools are offered to every run: no services, not in a room', () => {
  assert.deepEqual(names(runTools([], { inRoom: false, ...anyone })),
    [READ_ROOM_SUMMARY, CREATE_ROOM, 'send_dm', 'post_message', 'add_to_room']);
  assert.deepEqual(names(runTools([{ slug: 'linear', name: 'Linear' }], { inRoom: true, ...anyone })),
    ['find_tools', 'call_tool', 'open_panel', READ_ROOM_SUMMARY, CREATE_ROOM, 'send_dm', 'post_message', 'add_to_room']);
});

test('the prompt says to create a room only when asked, and last', () => {
  const prompt = toolsPrompt([], { inRoom: false, ...anyone });
  assert.match(prompt, /create_room/);
  assert.match(prompt, /LAST/);
  assert.match(prompt, /Never create a room nobody asked for/);
});

test('the prompt says where people\'s ids are, to message only who was asked for, and last', () => {
  const prompt = toolsPrompt([], { inRoom: false, ...anyone });
  assert.match(prompt, /\[Name\]\(actor:act_…\)/);
  assert.match(prompt, /Never message or add anyone the person did not ask for/);
  assert.match(prompt, /Do these LAST/);
});

test(`${WRITE_ROOM_SUMMARY} is offered to Roomkeeping in a room, and to nobody else`, () => {
  assert.ok(names(runTools([], { inRoom: true, isRoomkeeper: true })).includes(WRITE_ROOM_SUMMARY));
  // Not to another agent in the same room...
  assert.ok(!names(runTools([], { inRoom: true, isRoomkeeper: false })).includes(WRITE_ROOM_SUMMARY));
  // ...and not to Roomkeeping outside one: there is no summary to write.
  assert.ok(!names(runTools([], { inRoom: false, isRoomkeeper: true })).includes(WRITE_ROOM_SUMMARY));
});

test('the summary prompt says the body replaces everything, and to edit rather than rewrite', () => {
  const prompt = toolsPrompt([], { inRoom: true, isRoomkeeper: true });
  assert.match(prompt, /COMPLETE new summary/);
  assert.match(prompt, /anything you leave out is gone/);
  assert.match(prompt, /Never rewrite the summary on your own initiative/);
  // Nobody else is told about a tool they do not have.
  assert.doesNotMatch(toolsPrompt([], { inRoom: true, ...anyone }), /write_room_summary/);
});

test(`${READ_ROOM_SUMMARY} is offered to every run, not only Roomkeeping's`, () => {
  // Reading a summary is reading what the asker could already open; writing one
  // is speaking for the room. Only the write is gated.
  for (const where of [
    { inRoom: true, isRoomkeeper: true }, { inRoom: true, isRoomkeeper: false },
    { inRoom: false, isRoomkeeper: false },
  ]) {
    assert.ok(names(runTools([], where)).includes(READ_ROOM_SUMMARY), JSON.stringify(where));
  }
  assert.match(toolsPrompt([], { inRoom: false, ...anyone }), /read_room_summary/);
});
