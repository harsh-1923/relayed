import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { RelayedCommand, restoreCommandChip } from './relayed-command.ts';
import { RelayedMention } from './relayed-mention.ts';
import { shouldShowComposerPlaceholder } from './placeholder.ts';
import { parseSlashCommand } from '../../../../shared/slash-commands.ts';

function createEditor(body: string) {
  return new Editor({
    extensions: [StarterKit, RelayedCommand, RelayedMention, Markdown],
    content: body,
    contentType: 'markdown',
  });
}

for (const body of ['/compact', '/plugin:review-code check **this**', '/my_command first\n\nsecond', '/review [priya](actor:act_01)']) {
  test(`command chip preserves the draft and send body: ${body}`, () => {
    const editor = createEditor(body);
    try {
      editor.commands.setContent(restoreCommandChip(editor.getJSON()), { emitUpdate: false });
      assert.equal(editor.getJSON().content?.[0]?.content?.[0]?.type, 'relayedCommand');
      // Command names must stay literal; the default text serializer escapes underscores.
      assert.equal(editor.getMarkdown(), body);
      assert.deepEqual(parseSlashCommand(editor.getMarkdown()), parseSlashCommand(body));
      const restored = createEditor(editor.getMarkdown());
      try {
        restored.commands.setContent(restoreCommandChip(restored.getJSON()), { emitUpdate: false });
        assert.deepEqual(restored.getJSON(), editor.getJSON());
      } finally { restored.destroy(); }
      assert.equal(shouldShowComposerPlaceholder(editor.state.doc), false);
      assert.equal(editor.state.doc.firstChild?.firstChild?.nodeSize, 1);
      const document = editor.getJSON();
      assert.equal(restoreCommandChip(document), document);
    } finally { editor.destroy(); }
  });
}

for (const body of ['See /compact', '/tmp/file.txt', '`/compact`', '**/compact**', '> /compact', '```\n/compact\n```', 'first\n\n/compact']) {
  test(`does not turn non-command content into chips: ${body}`, () => {
    const editor = createEditor(body);
    try {
      const document = editor.getJSON();
      assert.equal(restoreCommandChip(document), document);
    } finally { editor.destroy(); }
  });
}
