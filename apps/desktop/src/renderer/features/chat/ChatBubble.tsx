import type { ReplicaMessage } from '../../../preload/api';
import { AlertCircle, ClockDefault } from '@relayed/icons';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import {
  Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader,
} from '@/components/ui/message';
import { MessageScrollerItem } from '@/components/ui/message-scroller';
import { blobSrc, initials } from '@/lib/ipc';
import { cn } from '@/lib/utils';

interface ChatBubbleProps {
  message: ReplicaMessage;
  mine: boolean;
  startsGroup: boolean;
  endsGroup: boolean;
}

export function ChatBubble({ message, mine, startsGroup, endsGroup }: ChatBubbleProps) {
  const align = mine ? 'end' : 'start';
  const showFooter = message.state !== 'acked' || endsGroup;

  return (
    <MessageScrollerItem
      messageId={message.id}
      // Consecutive rows remain individually addressable while visually
      // forming one sender stack. MessageScrollerContent supplies the normal
      // 24px row gap; pulling continuation rows up leaves the group's 8px gap.
      className={!startsGroup ? '-mt-4' : undefined}
    >
      <Message align={align}>
        {!mine && (
          <MessageAvatar className={!endsGroup ? 'invisible' : undefined}>
            <Avatar className="size-7">
              <AvatarImage src={blobSrc(message.authorAvatarBlob) ?? undefined} />
              <AvatarFallback className="text-[10px]">
                {initials(message.authorName)}
              </AvatarFallback>
            </Avatar>
          </MessageAvatar>
        )}

        <MessageContent>
          {!mine && startsGroup && <MessageHeader>{message.authorName}</MessageHeader>}

          <Bubble
            variant={mine ? 'outgoing' : 'muted'}
            align={align}
            className={cn(
              message.state === 'pending' && 'opacity-60',
              message.state === 'failed' && 'ring-1 ring-destructive',
            )}
          >
            <BubbleContent className="select-text">
              {message.deleted
                ? <span className="italic opacity-60">Message deleted</span>
                : message.body}
            </BubbleContent>
          </Bubble>

          {showFooter && (
            <MessageFooter>
              {message.state === 'pending' && (
                <span className="flex items-center gap-1" role="status">
                  <ClockDefault className="size-3" /> Queued
                </span>
              )}
              {message.state === 'failed' && (
                <span className="flex items-center gap-1 text-destructive" role="status">
                  <AlertCircle className="size-3" /> Not sent
                </span>
              )}
              {message.state === 'acked' && formatTime(message.createdAt)}
            </MessageFooter>
          )}
        </MessageContent>
      </Message>
    </MessageScrollerItem>
  );
}

const formatTime = (createdAt: number): string =>
  new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
