import { Node, type MarkdownToken } from '@tiptap/core';

/**
 * A durable semantic atom inside canonical Relayed Markdown.
 *
 * Four kinds, one node: `actor` and `audience` are written `@name`, a
 * `space` is written `#name` — the room reference people expect from Slack —
 * and `actor-ref` is a person named without notifying them (an agent writes
 * those; see the server's `agents/people.ts`).
 * They share a node because they share the thing that matters: an id that
 * survives a rename, carried in the body rather than resolved at read time.
 */
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
    }, `${sigil(node.attrs['kind'])}${node.attrs['label']}`];
  },
  renderText({ node }) { return `${sigil(node.attrs['kind'])}${node.attrs['label']}`; },
  markdownTokenName: 'relayedMention',
  markdownTokenizer: {
    name: 'relayedMention',
    level: 'inline',
    start(source: string) {
      return source.search(/\[[^\]\n]+\]\((?:actor|actor-ref|audience|space):[^)\s]+\)/);
    },
    tokenize(source: string) {
      const match = /^\[([^\]\n]+)\]\((actor|actor-ref|audience|space):([^)\s]+)\)/.exec(source);
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
    const given = node.attrs?.['kind'];
    // A reference stays a reference: written back as a mention, an edit would
    // start notifying someone the original did not.
    const kind = given === 'audience' || given === 'space' || given === 'actor-ref' ? given : 'actor';
    return `[${label}](${kind}:${String(node.attrs?.['id'] ?? '')})`;
  },
});

/** What a mention is written with: a room is `#`, a person or an audience is `@`. */
const sigil = (kind: unknown): string => (kind === 'space' ? '#' : '@');
