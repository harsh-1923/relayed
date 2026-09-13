import { Node, type JSONContent } from '@tiptap/core';

/** Editor-only atom: the command protocol remains ordinary /name text. */
export const RelayedCommand = Node.create({
  name: 'relayedCommand',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  marks: '',
  addAttributes() {
    return { name: { default: '' } };
  },
  parseHTML() { return [{ tag: 'span[data-relayed-command]' }]; },
  renderHTML({ node }) {
    return ['span', {
      'data-relayed-command': node.attrs['name'],
      name: node.attrs['name'],
      class: 'composer-mention composer-command',
      contenteditable: 'false',
      spellcheck: 'false',
    }, `/${node.attrs['name']}`];
  },
  renderText({ node }) { return `/${node.attrs['name']}`; },
  renderMarkdown(node) { return `/${String(node.attrs?.['name'] ?? '')}`; },
});

/** Restore only the leading command, never paths or slashes in rich content. */
export function restoreCommandChip(document: JSONContent): JSONContent {
  const paragraph = document.content?.[0];
  const first = paragraph?.content?.[0];
  if (paragraph?.type !== 'paragraph' || first?.type !== 'text' || first.marks?.length) return document;
  const match = /^\/([A-Za-z0-9][\w:.-]*)(?=\s|$)/.exec(first.text ?? '');
  if (!match) return document;
  const remaining = first.text!.slice(match[0].length);
  return { ...document, content: [
    { ...paragraph, content: [
      { type: 'relayedCommand', attrs: { name: match[1] } },
      ...(remaining ? [{ ...first, text: remaining }] : []),
      ...paragraph.content!.slice(1),
    ] },
    ...document.content!.slice(1),
  ] };
}
