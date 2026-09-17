// What agents are told about writing (writing.ts), and that the summary is
// asked to be rewritten rather than grown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WRITING_PROMPT, SUMMARY_SHAPE, SUMMARY_TOP_WORDS, SUMMARY_MAX_WORDS } from './writing.ts';
import { RULES, buildPrompt } from './summariser.ts';
import { ACTIONS_PROMPT } from './dispatcher.ts';

test('a reply is told to lead with the answer, stay short, and keep long material out of messages', () => {
  assert.match(WRITING_PROMPT, /Lead with the answer/);
  assert.match(WRITING_PROMPT, /under about 120 words/);
  assert.match(WRITING_PROMPT, /No preamble/);
  assert.match(WRITING_PROMPT, /belongs in a document or ticket, not a message/);
  assert.ok(ACTIONS_PROMPT.length > 0, 'the actions rule is a separate line, not replaced');
});

test('the summary puts the present first and the past last, compressed', () => {
  const order = ['**Now**', '**Open**', '**Recently decided**', '**Who’s on what**', '**Links**', '**Earlier**']
    .map(section => SUMMARY_SHAPE.indexOf(section));
  assert.ok(order.every(at => at >= 0), 'every section is named');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
  assert.match(SUMMARY_SHAPE, /never append/);
  assert.ok(SUMMARY_TOP_WORDS < SUMMARY_MAX_WORDS);
  assert.ok(RULES.includes(SUMMARY_SHAPE), 'the job that keeps the summary is given the shape');
});

test('an update pass is asked to rewrite and shorten, not to fold in', () => {
  const update = buildPrompt({ previous: '**Now** Old state.', lines: [{ chatId: 'cht_1', ord: 1, text: 'Alice: hi' }], rebuild: false });
  assert.doesNotMatch(update, /fold in/);
  assert.match(update, /Write the summary again/);
  assert.match(update, /move what is no longer\s+current into Earlier/);
  assert.match(update, /must not be longer/);
  const first = buildPrompt({ previous: '', lines: [{ chatId: 'cht_1', ord: 1, text: 'Alice: hi' }], rebuild: false });
  assert.match(first, /Write the room's summary/);
});
