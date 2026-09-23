import { useNavigate, useParams } from 'react-router';
import type { ReplicaMessage } from '../../../preload/api';
import { useSession } from '@/app/state';
import { spaceLinkTarget } from '../../../shared/spaces.ts';
import { AlertCircle, ClockDefault } from '@relayed/icons';
import { ActorAvatar } from '@/components/ActorAvatar';
import { useActor } from '@/lib/actors';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import {
  Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader,
} from '@/components/ui/message';
import { MessageScrollerItem } from '@/components/ui/message-scroller';
import { LANG, LIBRARY_VERSION } from '@relayed/genui';
import { ThinkingOrb } from 'thinking-orbs';
import { useAgentStream } from '@/lib/agent-stream';
import { cn } from '@/lib/utils';
import { CopyButton } from './CopyButton';
import type { AmbientPart, MemoryPart } from '@relayed/protocol';
import { MessageParts } from './MessageParts';
import { MemoryHoverCard } from './MemoryHoverCard';
import { AmbientReference, DismissAmbient } from './AmbientMarker';
import { openLink as openInRoomPanel, showAnnotation } from '@/lib/panel-navigation';
import { isAnnotationLink } from '../../../shared/annotations.ts';
import { isWebUrl, withoutFragmentDirective } from '../../../shared/web-panels.ts';
import { call } from '@/lib/ipc';

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
  const authorName = useActor(message.authorId)?.displayName ?? message.authorName;
  // A restricted message always shows who it is for, mid-stack or not: that is
  // not detail to reveal on hover.
  const showFooter = message.state !== 'acked' || endsGroup || message.visibleTo !== null;
  // An agent's message is laid out as a page, not a speech bubble — cards and
  // tool calls inside a tinted bubble capped at 70% are cramped and read as
  // quoted — whether or not THIS message has parts: a tool posting plain text
  // (`post_message`) is still the agent speaking, and must not read as a
  // person's message just because it has no cards attached. Everyone else's
  // message keeps its bubble.
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
  const unbubbled = !message.deleted && agentAuthored;
  // Only an agent's own reply may claim to have cited memory; on anyone else's
  // message the part is a costume, and the protocol refuses to draw it there
  // (`undrawablePartKind`).
  const memoryPart = agentAuthored
    ? (parts ?? []).find((part): part is MemoryPart => part.kind === 'memory')
    : undefined;
  // The server's marker that nobody asked for this answer — only ever drawn on
  // an agent, for the reason the memory part is (`undrawablePartKind`).
  const ambientPart = agentAuthored
    ? (parts ?? []).find((part): part is AmbientPart => part.kind === 'ambient')
    : undefined;
  const navigate = useNavigate();
  const { state: session } = useSession();
  // A passage someone marked opens beside the chat, at the passage
  // (docs/ANNOTATIONS.md); an ordinary link opens beside it too, at its own
  // address — both through the room, because the panel list is its.
  const { spaceId: roomId = '' } = useParams();
  // Command/Ctrl-click always goes to the system browser — the browser's own
  // "open in a new tab" gesture, kept for a link in a message. A plain click
  // opens it beside the chat: a room's tab (the pub/sub `openLink` a web
  // panel's own links already use — WebPanel.tsx), or the passage it marks.
  const openLink = (href: string, event?: React.MouseEvent): void => {
    const external = event ? event.metaKey || event.ctrlKey : false;
    if (isAnnotationLink(href)) {
      if (external) void call(api => api.query('web.openExternal', { url: withoutFragmentDirective(href) }));
      else showAnnotation(roomId, href);
      return;
    }
    const spaceId = spaceLinkTarget(href);
    if (spaceId) {
      if (session.workspaceId) void navigate(`/w/${session.workspaceId}/s/${spaceId}`);
      return;
    }
    if (!isWebUrl(href)) return;
    if (external) void call(api => api.query('web.openExternal', { url: href }));
    // Only a room has a panel to open it beside; elsewhere this link has
    // nowhere to land yet and a plain click stays a no-op, as it already was.
    else if (roomId) openInRoomPanel(roomId, { address: href, background: false });
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
            <ActorAvatar id={message.authorId} className="size-7" fallbackClassName="text-[10px]" profileOnHover />
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
              {authorName}
              {ambientPart && <AmbientReference part={ambientPart} />}
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
              {memoryPart && !message.deleted && !streaming && (
                // Beside the copy button, because both answer "what is behind
                // this reply" — one gives you the text, the other where it came
                // from (MEMORY.md §7.2).
                <MemoryHoverCard part={memoryPart} onOpenLink={openLink} />
              )}
              {ambientPart && !message.deleted && (
                <DismissAmbient
                  messageId={message.id}
                  className="opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100"
                />
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
