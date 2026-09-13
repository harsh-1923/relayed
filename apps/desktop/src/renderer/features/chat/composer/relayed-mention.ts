import { Node, type MarkdownToken } from '@tiptap/core';

/** A durable semantic atom inside canonical Relayed Markdown. */
export const RelayedMention = Node.create({
  name: 'relayedMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return { id: { default: null }, label: { default: null }, kind: { default: 'actor' } };
  },
  parseHTML() { return [{ tag: 'span[data-relayed-mention]' }]; },
  renderHTML({ node }) {
    return ['span', {
      'data-relayed-mention': node.attrs['kind'],
      'data-id': node.attrs['id'],
      class: 'composer-mention',
    }, `@${node.attrs['label']}`];
  },
  renderText({ node }) { return `@${node.attrs['label']}`; },
  markdownTokenName: 'relayedMention',
  markdownTokenizer: {
    name: 'relayedMention',
    level: 'inline',
    start(source: string) {
      return source.search(/\[[^\]\n]+\]\((?:actor|audience):[^)\s]+\)/);
    },
    tokenize(source: string) {
      const match = /^\[([^\]\n]+)\]\((actor|audience):([^)\s]+)\)/.exec(source);
      if (!match) return undefined;
      return {
        type: 'relayedMention', raw: match[0],
        label: match[1], kind: match[2], id: match[3],
      } as MarkdownToken;
    },
  },
  parseMarkdown(token, helpers) {
    return helpers.createNode('relayedMention', {
      label: String(token['label']), kind: String(token['kind']), id: String(token['id']),
    });
  },
  renderMarkdown(node) {
    const label = String(node.attrs?.['label'] ?? '').replaceAll(']', '\\]');
    const kind = node.attrs?.['kind'] === 'audience' ? 'audience' : 'actor';
    return `[${label}](${kind}:${String(node.attrs?.['id'] ?? '')})`;
  },
});
