// `body` from parts, and the check a server runs before storing a ui part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessagePart } from '@relayed/protocol';
import { deriveBody, summariseTool } from './body.ts';
import { libraryVersion, uiPartRefusal } from './validate.ts';

const BLOCK = [
  'root = Card([header, stats, next])',
  'header = CardHeader("catchup.test.ts is flaky", "3 of 20 runs failed")',
  'stats = Stack([passed, failed], "row")',
  'passed = Stat("Passed", "17", "success")',
  'failed = Stat("Failed", "3", "danger")',
  'next = Actions([apply])',
  'apply = Reply("Apply the fix", "Apply the one-line fix to catchup.test.ts", true)',
].join('\n');

const ui = (source: string, library = 'relayed-ui@1', lang = 'openui-lang@0.5') =>
  ({ kind: 'ui', lang, library, source }) as const;

test('body reads as the reply: text verbatim, a tool as one line, a block as its data', () => {
  const parts: MessagePart[] = [
    { kind: 'markdown', text: 'I ran the test 20 times.' },
    { kind: 'tool', tool_use_id: 'toolu_01', name: 'Bash', ok: true, ms: 2210, input: { command: 'node --test catchup.test.ts' } },
    ui(BLOCK),
    { kind: 'markdown', text: 'The fix is a one-line await.' },
  ];
  const body = deriveBody(parts);
  assert.match(body, /^I ran the test 20 times\.\n\n▸ Bash `node --test catchup.test.ts`\n\n/);
  assert.match(body, /catchup\.test\.ts is flaky/);
  assert.match(body, /Passed: 17/, 'the numbers, not only the headers');
  assert.match(body, /\n\nThe fix is a one-line await\.$/);
});

test('a reply through a button is the words sent; the choice itself adds nothing to body', () => {
  const body = deriveBody([
    { kind: 'reply_to_ui', message_id: 'msg_A2', label: 'Apply the fix' },
    { kind: 'markdown', text: 'Apply the one-line fix to catchup.test.ts' },
  ]);
  assert.equal(body, 'Apply the one-line fix to catchup.test.ts');
});

test('a tool summary is its first line, and survives backticks in Markdown', () => {
  assert.equal(summariseTool({ command: 'echo one\necho two' }), 'echo one');
  assert.equal(summariseTool({ file_path: 'a.ts', command: 'later key' }), 'later key', 'command is looked for first');
  assert.equal(summariseTool({ unrelated: 1 }), '');
  assert.equal(summariseTool('not an object'), '');
  const body = deriveBody([{ kind: 'tool', tool_use_id: 't', name: 'Bash', ok: true, ms: 1, input: { command: 'echo `date`' } }]);
  assert.equal(body, '▸ Bash `` echo `date` ``');
});

test('a valid ui part is stored', () => {
  assert.equal(uiPartRefusal(ui(BLOCK)), null);
});

test('a ui part is refused with one code, never its source', () => {
  assert.equal(uiPartRefusal(ui('root = Card([x])\nx = Sparkline([1,2])')), 'unknown-component');
  assert.equal(uiPartRefusal(ui(BLOCK, 'relayed-ui@2')), 'unknown-library', 'newer than this server');
  assert.equal(uiPartRefusal(ui(BLOCK, 'someone-elses-ui@1')), 'unknown-library');
  assert.equal(uiPartRefusal(ui(BLOCK, 'relayed-ui@1', 'openui-lang@0.6')), 'unknown-lang');
});

test('library versions', () => {
  assert.equal(libraryVersion('relayed-ui@1'), 1);
  assert.equal(libraryVersion('relayed-ui@12'), 12);
  assert.ok(Number.isNaN(libraryVersion('relayed-ui@')));
  assert.ok(Number.isNaN(libraryVersion('relayed-ui@1.5')));
});
