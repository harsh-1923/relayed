// The composer's mention chip, drawn the way a sent message draws it: a person
// or agent with their face before the name, a room or an audience with its
// sigil. The node itself — its attributes, Markdown and plain text — is
// `relayed-mention.ts`; only how it looks in the editor is here.
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { ActorAvatar } from '@/components/ActorAvatar';
import { RelayedMention } from './relayed-mention.ts';

function MentionView({ node }: ReactNodeViewProps) {
  const kind = String(node.attrs['kind'] ?? 'actor');
  const label = String(node.attrs['label'] ?? '');
  const id = typeof node.attrs['id'] === 'string' ? node.attrs['id'] : null;
  if (kind !== 'actor') {
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
