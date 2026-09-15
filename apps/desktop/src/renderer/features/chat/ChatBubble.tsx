import { useNavigate } from 'react-router';
import type { ReplicaMessage } from '../../../preload/api';
import { useSession } from '@/app/state';
import { spaceLinkTarget } from '../../../shared/spaces.ts';
import { AlertCircle, ClockDefault } from '@relayed/icons';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import {
  Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader,
} from '@/components/ui/message';
import { MessageScrollerItem } from '@/components/ui/message-scroller';
import { LANG, LIBRARY_VERSION } from '@relayed/genui';
import { ThinkingOrb } from 'thinking-orbs';
import { useAgentStream } from '@/lib/agent-stream';
import { blobSrc, initials } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { CopyButton } from './CopyButton';
import { MessageParts } from './MessageParts';

interface ChatBubbleProps {
  message: ReplicaMessage;
  mine: boolean;
  startsGroup: boolean;
  endsGroup: boolean;
  /** A local reply paused on the person: an approval, a question or a plan (LOCAL-ROOMS.md §8.5). */
  waiting?: boolean;
}

export function ChatBubble({ message, mine, startsGroup, endsGroup, waiting = false }: ChatBubbleProps) {
  const align = mine ? 'end' : 'start';
  const agentAuthored = message.authorType === 'agent';
  // A restricted message always shows who it is for, mid-stack or not: that is
  // not detail to reveal on hover.
  const showFooter = message.state !== 'acked' || endsGroup || message.visibleTo !== null;
  // An agent's reply with parts is laid out as a page, not a speech bubble:
  // cards and tool calls inside a tinted bubble capped at 70% are cramped and
  // read as quoted. Everyone else's message keeps its bubble.
  // A reply Claude is still writing in a local room (LOCAL-ROOMS.md §8.3): its
  // stored parts, plus the text of the block arriving now, which is pushed and
  // never stored.
  const streaming = message.state === 'streaming';
  const live = useAgentStream(message.id, streaming);
  // A block that has landed as a part is still in the live push until the next
  // block starts; drawing both would show the card twice.
  const storedUi = message.parts?.findLast(part => part.kind === 'ui')?.['source'];
  const liveParts = [
    ...(live.text ? [{ kind: 'markdown', text: live.text }] : []),
    ...(live.ui && live.ui !== storedUi ? [{ kind: 'ui', lang: LANG, library: LIBRARY_VERSION, source: live.ui }] : []),
  ];
  const arriving = liveParts.length > 0;
  const parts = streaming && arriving ? [...(message.parts ?? []), ...liveParts] : message.parts;
  const unbubbled = !message.deleted && agentAuthored && (parts !== null || streaming);
  const navigate = useNavigate();
  const { state: session } = useSession();
  // Only a link to a room in this workspace opens anything so far — the room an
  // agent made. Where a web link opens, and which schemes may, is phase 6
  // (docs/AGENT-RESPONSES.md, actions).
  const openLink = (href: string): void => {
    const spaceId = spaceLinkTarget(href);
    if (spaceId && session.workspaceId) void navigate(`/w/${session.workspaceId}/s/${spaceId}`);
  };

  return (
    <MessageScrollerItem
      messageId={message.id}
      // Consecutive rows remain individually addressable while visually
      // forming one sender stack. MessageScrollerContent supplies the normal
      // 24px row gap; pulling continuation rows up leaves the group's 8px gap.
      // Agent replies each carry their own page-style author divider, including
      // consecutive replies from the same agent, so they keep the normal gap.
      className={!startsGroup && !agentAuthored ? '-mt-4' : undefined}
    >
      <Message align={align}>
        {!mine && (
          // Sized to the avatar: the slot's own 32px minimum left a muted rim
          // around the 28px face. Lifted by exactly the footer row (h-5) so it sits
          // level with the bubble's last line: the slot's own lift is 32px, which
          // pushed it out of the row, and a row with `content-visibility: auto`
          // clips whatever leaves it.
          <MessageAvatar className={cn('size-7 min-w-0 group-has-data-[slot=message-footer]/message:-translate-y-8.25', !endsGroup && 'invisible')}>
            <Avatar className="size-7 overflow-hidden">
              <AvatarImage src={blobSrc(message.authorAvatarBlob) ?? undefined} />
              <AvatarFallback className="text-[10px]">
                {initials(message.authorName)}
              </AvatarFallback>
            </Avatar>
          </MessageAvatar>
        )}

        <MessageContent>
          {!mine && (startsGroup || agentAuthored) && (
            <MessageHeader
              // Agent replies read as a page, so their author belongs in a
              // full-width metadata row rather than as a small bubble label.
              className={agentAuthored
                ? 'w-full border-b border-border px-0 pb-2.5 text-sm font-normal'
                : undefined}
            >
              {message.authorName}
            </MessageHeader>
          )}

          <Bubble
            variant={unbubbled ? 'ghost' : mine ? 'outgoing' : 'muted'}
            align={align}
            className={cn(
              message.state === 'pending' && 'opacity-60',
              // A person's message that never sent is outlined; an agent's reply
              // that did not finish says so in its footer and keeps what it wrote.
              message.state === 'failed' && !unbubbled && 'ring-1 ring-destructive',
            )}
          >
            {/* The base layer makes every element unselectable, so selection is
                re-enabled on each descendant, not just inherited. */}
            <BubbleContent className="select-text **:select-text">
              {message.deleted
                ? <span className="italic opacity-60">Message deleted</span>
                // Reply buttons do nothing yet; see `openLink` for links.
                : (
                  <>
                    <MessageParts
                      body={message.body}
                      parts={parts}
                      authorType={message.authorType ?? 'human'}
                      streaming={streaming}
                      onOpenLink={openLink}
                    />
                    {streaming && (
                      <span className="flex items-center gap-2 text-sm pt-6" role="status">
                        {waiting
                          ? <><ThinkingOrb state="listening" size={20} aria-hidden /> Waiting for you</>
                          : <><ThinkingOrb state="working" size={20} aria-hidden /> Working…</>}
                      </span>
                    )}
                  </>
                )}
            </BubbleContent>
          </Bubble>

          {/* Only the last message in a sender stack has the ordinary footer,
              and its height is permanent. Expanding a continuation row on
              hover moved every message below it. Exceptional state and
              visibility labels still surface immediately, even mid-stack. */}
          {showFooter && (
            <MessageFooter className="h-5 gap-1">
              {message.state === 'pending' && (
                <span className="flex items-center gap-1" role="status">
                  <ClockDefault className="size-3" /> Queued
                </span>
              )}
              {message.state === 'failed' && (
                <span className="flex items-center gap-1 text-destructive" role="status">
                  <AlertCircle className="size-3" /> {agentAuthored ? 'Did not finish' : 'Not sent'}
                </span>
              )}
              {message.state === 'acked' && formatTime(message.createdAt)}
              {message.visibleTo && (
                // Said, not implied: somebody replying out loud to a message
                // nobody else can see would otherwise be talking to themselves.
                <span className="flex items-center gap-1">· {visibleToLabel(message.visibleTo)}</span>
              )}
              {!mine && !message.deleted && !streaming && message.body && (
                // As its Markdown source. An agent's body is derived from its
                // parts: tool lines come along as one-line summaries, cards not at all.
                <CopyButton
                  text={message.body}
                  label="Copy message"
                  className="opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100 data-copied:opacity-100"
                />
              )}
            </MessageFooter>
          )}
        </MessageContent>
      </Message>
    </MessageScrollerItem>
  );
}

const formatTime = (createdAt: number): string =>
  new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * "Only visible to you", or "… and 2 others". A replica only ever holds a
 * restricted message its owner is listed on, so "you" is always true.
 */
const visibleToLabel = (visibleTo: string[]): string => {
  const others = visibleTo.length - 1;
  if (others <= 0) return 'Only visible to you';
  return `Only visible to you and ${others} ${others === 1 ? 'other' : 'others'}`;
};
