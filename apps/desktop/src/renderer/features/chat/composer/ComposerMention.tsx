// The composer's mention chip, drawn the way a sent message draws it: a person
// or agent with their face before the name, a room or an audience with its
// sigil. The node itself — its attributes, Markdown and plain text — is
// `relayed-mention.ts`; only how it looks in the editor is here.
import type { MarkdownToken } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { ActorAvatar } from '@/components/ActorAvatar';
import { RelayedMention } from './relayed-mention.ts';

function MentionView({ node }: ReactNodeViewProps) {
  const kind = String(node.attrs['kind'] ?? 'actor');
  const label = String(node.attrs['label'] ?? '');
  const id = typeof node.attrs['id'] === 'string' ? node.attrs['id'] : null;
  if (kind !== 'actor' && kind !== 'actor-ref') {
    return <NodeViewWrapper as="span">{kind === 'space' ? '#' : '@'}{label}</NodeViewWrapper>;
  }
  return (
    <NodeViewWrapper as="span" className="composer-mention-actor">
      <ActorAvatar id={id} fallbackName={label} className="composer-mention-avatar" fallbackClassName="text-[8px]" />
      {label}
    </NodeViewWrapper>
  );
}

export const ComposerMention = RelayedMention.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MentionView, {
      as: 'span',
      className: 'composer-mention',
      attrs: ({ node }) => ({ 'data-relayed-mention': String(node.attrs['kind']), 'data-id': String(node.attrs['id'] ?? '') }),
    });
  },
});

/**
 * The same chip in a document — a room's summary — for people alone. Rooms stay
 * the document's own anchors, which `DocPanel` opens as links; the node would
 * turn them into chips that go nowhere.
 */
export const DocumentMention = ComposerMention.extend({
  markdownTokenizer: {
    name: 'relayedMention',
    level: 'inline',
    start(source: string) {
      return source.search(/\[[^\]]+\]\((?:actor|actor-ref):[^)\s]+\)/);
    },
    tokenize(source: string) {
      const match = /^\[([^\]\n]+)\]\((actor|actor-ref):([^)\s]+)\)/.exec(source);
      if (!match) return undefined;
      return {
        type: 'relayedMention', raw: match[0],
        label: match[1], kind: match[2], id: match[3],
      } as MarkdownToken;
    },
  },
});
