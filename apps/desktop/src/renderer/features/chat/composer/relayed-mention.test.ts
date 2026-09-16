import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { RelayedMention } from './relayed-mention.ts';

const roundTrip = (body: string): { body: string; json: ReturnType<Editor['getJSON']> } => {
  const editor = new Editor({
    extensions: [StarterKit.configure({ heading: false, horizontalRule: false }), RelayedMention, Markdown],
    content: body,
    contentType: 'markdown',
  });
  const result = { body: editor.getMarkdown(), json: editor.getJSON() };
  editor.destroy();
  return result;
};

test('actor mentions retain the durable actor id through Markdown', () => {
  const result = roundTrip('Hello [priya](actor:act_01ABC).');
  assert.equal(result.body, 'Hello [priya](actor:act_01ABC).');
  const mention = result.json.content?.[0]?.content?.[1] as { type?: string; attrs?: Record<string, unknown> } | undefined;
  assert.deepEqual({ ...mention, attrs: { ...mention?.attrs } }, {
    type: 'relayedMention', attrs: { id: 'act_01ABC', label: 'priya', kind: 'actor' },
  });
});

test('a reference to an actor stays a reference, never becoming a mention', () => {
  const result = roundTrip('Ask [Harsh](actor-ref:act_01ABC) about it.');
  assert.equal(result.body, 'Ask [Harsh](actor-ref:act_01ABC) about it.');
  const mention = result.json.content?.[0]?.content?.[1] as { type?: string; attrs?: Record<string, unknown> } | undefined;
  assert.equal(mention?.attrs?.['kind'], 'actor-ref');
});

test('audience mentions stay semantically separate from actors', () => {
  const result = roundTrip('[here](audience:here) please read this.');
  assert.equal(result.body, '[here](audience:here) please read this.');
  const mention = result.json.content?.[0]?.content?.[0] as { type?: string; attrs?: Record<string, unknown> } | undefined;
  assert.deepEqual({ ...mention, attrs: { ...mention?.attrs } }, {
    type: 'relayedMention', attrs: { id: 'here', label: 'here', kind: 'audience' },
  });
});

test('ordinary rich Markdown round-trips alongside mentions', () => {
  const body = '**Bold** and `code`\n\n> quote\n\n- one\n- two\n\n```ts\nconst answer = 42\n```';
  assert.equal(roundTrip(body).body, body);
});
