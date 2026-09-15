// A message's parts: strict where they are written, lenient where they are read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forbiddenPartKind, undrawablePartKind, PART_KINDS, PART_LIMITS, Parts, readStoredParts } from './parts.ts';

const tool = {
  kind: 'tool', tool_use_id: 'toolu_01', name: 'Bash', ok: true, ms: 2210,
  input: { command: 'node --test' }, output_preview: '# pass 17', output_bytes: 5120,
};
const ui = { kind: 'ui', lang: 'openui-lang@0.5', library: 'relayed-ui@1', source: 'root = Card([])' };

test('every kind the contract names parses, and nothing else is a kind', () => {
  const parsed = Parts.safeParse([
    { kind: 'markdown', text: 'I ran the test.' }, tool, ui,
    { kind: 'reply_to_ui', message_id: 'msg_A2', label: 'Apply the fix' },
  ]);
  assert.equal(parsed.success, true);
  assert.deepEqual([...PART_KINDS].sort(), ['access_request', 'markdown', 'reply_to_ui', 'tool', 'ui']);
});

test('keys are snake_case: a camelCase part is refused on write, not silently emptied', () => {
  // Zod strips undeclared keys, so without `tool_use_id` being required a
  // camelCase writer would store a tool part with no id and nobody would know.
  const parsed = Parts.safeParse([{ ...tool, tool_use_id: undefined, toolUseId: 'toolu_01' }]);
  assert.equal(parsed.success, false);
});

test('an unknown kind is refused on write', () => {
  // The server is the newest program in the conversation; a kind it does not
  // know is a mistake, not the future.
  assert.equal(Parts.safeParse([{ kind: 'poll', question: 'Ship it?' }]).success, false);
});

test('empty parts are refused: a message without parts omits the field', () => {
  assert.equal(Parts.safeParse([]).success, false);
});

test('the byte limits hold', () => {
  const bigInput = { ...tool, input: { command: 'x'.repeat(PART_LIMITS.maxToolInputBytes) } };
  assert.equal(Parts.safeParse([bigInput]).success, false, 'a tool input');
  const bigPreview = { ...tool, output_preview: 'x'.repeat(PART_LIMITS.maxOutputPreviewChars + 1) };
  assert.equal(Parts.safeParse([bigPreview]).success, false, 'an output preview');
  const many = Array.from({ length: 40 }, () => ({ kind: 'markdown', text: 'x'.repeat(8_000) }));
  assert.equal(Parts.safeParse(many).success, false, 'the whole message');
  const tooMany = Array.from({ length: PART_LIMITS.maxParts + 1 }, () => ({ kind: 'markdown', text: 'x' }));
  assert.equal(Parts.safeParse(tooMany).success, false, 'the number of parts');
});

test('only an agent may write tool and ui parts', () => {
  assert.equal(forbiddenPartKind('agent', [tool, ui]), null);
  assert.equal(forbiddenPartKind('human', [{ kind: 'markdown' }, ui]), 'ui');
  assert.equal(forbiddenPartKind('human', [tool]), 'tool');
  assert.equal(forbiddenPartKind('human', [{ kind: 'reply_to_ui' }, { kind: 'markdown' }]), null,
    'a person replying through a button');
});

test('access_request is refused for every author on the ordinary write path, agents included', () => {
  const accessRequest = { kind: 'access_request' };
  assert.equal(forbiddenPartKind('human', [accessRequest]), 'access_request');
  assert.equal(forbiddenPartKind('agent', [accessRequest]), 'access_request',
    'unlike tool and ui, not even an agent may write one this way — only the broker, through trustedParts');
});

test('an access card stored on an agent\'s message is drawn; on a person\'s it never is', () => {
  const accessRequest = { kind: 'access_request' };
  assert.equal(undrawablePartKind('agent', [accessRequest]), null,
    'the broker writes cards as the agent — the write rule refusing it must not hide it from the reader');
  assert.equal(undrawablePartKind('human', [accessRequest]), 'access_request');
  assert.equal(undrawablePartKind('human', [{ kind: 'markdown' }, tool]), 'tool');
  assert.equal(undrawablePartKind('agent', [tool, ui]), null);
});

test('stored parts are read leniently: an unknown kind survives for the renderer to fall back on', () => {
  const stored = JSON.stringify([{ kind: 'markdown', text: 'hi' }, { kind: 'poll', question: 'Ship it?' }]);
  assert.deepEqual(readStoredParts(stored)?.map(part => part.kind), ['markdown', 'poll']);
});

test('stored parts that are not parts read as none, so body is shown', () => {
  assert.equal(readStoredParts(null), null);
  assert.equal(readStoredParts('not json'), null);
  assert.equal(readStoredParts('{"kind":"markdown"}'), null, 'not an array');
  assert.equal(readStoredParts('[]'), null);
  assert.equal(readStoredParts('[{"text":"no kind"}]'), null);
});
