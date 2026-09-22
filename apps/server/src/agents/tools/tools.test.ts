// What a run is offered (run-tools.ts). The broker's answers are broker.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTools, toolsPrompt, CREATE_ROOM, WRITE_ROOM_SUMMARY, READ_ROOM_SUMMARY, REMEMBER, WEB_SEARCH } from './index.ts';
import { env } from '../../env.ts';

/** Every run that is not Roomkeeping's, which is every run but one agent's. */
const anyone = { isRoomkeeper: false };

/**
 * Tool names, minus the ones whose OFFER depends on deployment configuration.
 *
 * `remember` follows `MEMORY_RECALL` (MEMORY.md §5.5) and `web_search` follows
 * `PARALLEL_API_KEY`, so pinning the full list would make this test pass or
 * fail on what the machine running it happens to have switched on — which it
 * did, in both directions, before this filter existed. Each gate is asserted
 * below, on its own terms.
 */
const CONFIGURED: readonly string[] = [REMEMBER, WEB_SEARCH];
const names = (tools: ReturnType<typeof runTools>) =>
  tools.map(tool => tool.name).filter(name => !CONFIGURED.includes(name));
test('create_room and the messaging tools are offered to every run: no services, not in a room', () => {
  assert.deepEqual(names(runTools([], { inRoom: false, ...anyone })),
    [READ_ROOM_SUMMARY, 'room_members', 'external_identity', CREATE_ROOM, 'send_dm', 'post_message', 'add_to_room']);
  assert.deepEqual(names(runTools([{ slug: 'linear', name: 'Linear' }], { inRoom: true, ...anyone })),
    ['find_tools', 'call_tool', 'open_panel', READ_ROOM_SUMMARY, 'room_members', 'external_identity', CREATE_ROOM, 'start_side_chat',
      'send_dm', 'post_message', 'add_to_room']);
});

test('remember is offered exactly when recall is, and never otherwise', () => {
  // A preference nothing will ever read is not worth asking somebody to state.
  const offered = runTools([], { inRoom: false, ...anyone }).map(tool => tool.name);
  assert.equal(offered.includes(REMEMBER), env.memoryRecall);
});

test('web_search is offered exactly when a search key is set, and never otherwise', () => {
  // The one tool billed to US rather than to the invoker: a deployment that
  // has not paid for it must not be able to call it by naming it.
  const offered = runTools([], { inRoom: false, ...anyone }).map(tool => tool.name);
  assert.equal(offered.includes(WEB_SEARCH), env.parallelApiKey !== null);
  assert.equal(/web_search/.test(toolsPrompt([], { inRoom: false, ...anyone })), env.parallelApiKey !== null);
});

test('the web is offered after everything that reads this workspace', () => {
  // The order decides what the model sees first, and the room's own answer is
  // better evidence about the room than the web's.
  const order = runTools([], { inRoom: true, ...anyone }).map(tool => tool.name);
  const web = order.indexOf(WEB_SEARCH);
  if (web === -1) return;
  for (const read of [READ_ROOM_SUMMARY, 'room_members', 'external_identity']) {
    assert.ok(order.indexOf(read) < web, `${read} comes before ${WEB_SEARCH}`);
  }
  assert.ok(web < order.indexOf(CREATE_ROOM), 'and before anything that writes');
});

test('the prompt says to create a room only when asked, and last', () => {
  const prompt = toolsPrompt([], { inRoom: false, ...anyone });
  assert.match(prompt, /create_room/);
  assert.match(prompt, /LAST/);
  assert.match(prompt, /Never create a room nobody asked for/);
});

test('the prompt says where people\'s ids are, to message only who was asked for, and last', () => {
  const prompt = toolsPrompt([], { inRoom: false, ...anyone });
  assert.match(prompt, /carry their actor id \(act_…\)/);
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
