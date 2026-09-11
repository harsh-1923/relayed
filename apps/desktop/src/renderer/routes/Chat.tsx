// One chat: its messages, and somewhere to type.
//
// Every row comes from the replica. Nothing here waits on the network, in
// either direction — the list is a local read, and composing writes to the
// outbox and returns. That is the whole point: this surface behaves identically
// with the server switched off, which is the property the aeroplane toggle in
// the dev strip exists to prove.
//
// THE SENDER SEES ITS OWN MESSAGE TWICE and must not notice. Once as the
// optimistic row written with the outbox entry, once as the `message.created`
// event travelling the same path it takes to every other device. The upsert in
// `effects.ts` is what makes the second one land on the first rather than beside
// it; here it means a message never jumps or duplicates as it is acknowledged.
//
// SCROLLING IS THE SCROLLER'S, not ours. A first version used an overflow div
// and a `scrollIntoView` on a ref, which is the hand-rolled stick-to-bottom the
// primitive exists to replace — it does the anchoring, the position restore and
// the jump-to-latest, and it yields the moment somebody scrolls up.
import { useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@/lib/query';
import { call, blobSrc, initials } from '@/lib/ipc';
import { useSession } from '@/app/state';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import {
  Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader,
} from '@/components/ui/message';
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent,
  MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { cn } from '@/lib/utils';
import { AlertCircle, Clock, SendHorizontal } from 'lucide-react';

export function Chat() {
  const { chatId } = useParams();
  const { state } = useSession();
  const me = state.workspaces.find(w => w.workspaceId === state.workspaceId)?.actorId;

  const { rows: messages, status } = useQuery('messages.list', { chatId: chatId ?? '' });

  return (
    // Sized here rather than by stretching the shell, so every other route
    // keeps the padding it was written against.
    <div className="-m-10 flex h-svh min-h-0 flex-col">
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent className="p-6">
              {status === 'loading' && (
                <p className="text-sm text-muted-foreground">Reading…</p>
              )}
              {status === 'empty' && (
                <p className="text-sm text-muted-foreground">
                  Nothing here yet. Say something — it is written to this device first.
                </p>
              )}

              {(messages ?? []).map(message => {
                const mine = message.authorId === me;
                const align = mine ? 'end' : 'start';
                return (
                  <MessageScrollerItem
                    key={message.id}
                    messageId={message.id}
                    // Anchor on our own messages: sending is the moment the
                    // view should hold, and somebody else's arrival must not
                    // yank a reader away from what they were reading.
                    scrollAnchor={mine}
                  >
                    <Message align={align}>
                      {!mine && (
                        <MessageAvatar>
                          <Avatar className="size-7">
                            <AvatarImage
                              src={blobSrc(message.authorAvatarBlob) ?? undefined}
                            />
                            <AvatarFallback className="text-[10px]">
                              {initials(message.authorName)}
                            </AvatarFallback>
                          </Avatar>
                        </MessageAvatar>
                      )}

                      <MessageContent>
                        {!mine && <MessageHeader>{message.authorName}</MessageHeader>}

                        {/* `align` is not decoration: it is what gives the
                            bubble `self-end`. Without it the bubble takes the
                            row's full width rule and `w-fit` collapses to the
                            longest word — which is how a first version rendered
                            "hello" one character per line. */}
                        <Bubble
                          variant={mine ? 'default' : 'muted'}
                          align={align}
                          className={cn(
                            // PENDING IS VISIBLE, and understated on purpose. It
                            // is the ordinary state of a message for a few
                            // hundred milliseconds, so it must not look like a
                            // problem — but rendering it identically to an
                            // acknowledged one is how a message that never sent
                            // looks exactly like one that did (DESIGN.md §10.2).
                            message.state === 'pending' && 'opacity-60',
                            message.state === 'failed' && 'ring-1 ring-destructive',
                          )}
                        >
                          <BubbleContent>
                            {message.deleted
                              ? <span className="italic opacity-60">Message deleted</span>
                              : message.body}
                          </BubbleContent>
                        </Bubble>

                        <MessageFooter>
                          {message.state === 'pending' && (
                            <span className="flex items-center gap-1">
                              <Clock className="size-3" /> Queued
                            </span>
                          )}
                          {message.state === 'failed' && (
                            <span className="flex items-center gap-1 text-destructive">
                              <AlertCircle className="size-3" /> Not sent
                            </span>
                          )}
                          {/* An acked message says only the time: "it worked"
                              is the default and needs no label. */}
                          {message.state === 'acked' && time(message.createdAt)}
                        </MessageFooter>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                );
              })}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <Composer chatId={chatId} />
    </div>
  );
}

function Composer({ chatId }: { chatId: string | undefined }) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  async function send() {
    const text = body.trim();
    if (!chatId || text.length === 0) return;
    // CLEARED FIRST, deliberately. The write is local and the invalidation
    // repaints from the replica, so the optimistic row appears either way —
    // and a box that empties only after a round trip feels broken offline,
    // which is precisely when it must not.
    setBody('');
    setError(null);
    try {
      await call(api => api.query('messages.send', { chatId, body: text }));
    } catch (e) {
      // Put it back rather than lose it. A failure here is the queue refusing,
      // not the network — nothing about sending waits on a socket.
      setBody(text);
      setError((e as Error).message);
    }
    box.current?.focus();
  }

  return (
    <div className="shrink-0 border-t border-border/60 p-4">
      {error && <p className="pb-2 text-sm text-destructive">{error}</p>}
      <div className="flex items-end gap-2">
        <Textarea
          ref={box}
          value={body}
          onChange={e => setBody(e.target.value)}
          // Return sends, shift-return is a newline. The chat convention, and
          // the reason the composer is a textarea rather than an input.
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
          placeholder="Message"
          className="max-h-40 min-h-10 resize-none"
          rows={1}
        />
        <Button size="icon" onClick={() => void send()} disabled={body.trim().length === 0}>
          <SendHorizontal className="size-4" />
          <span className="sr-only">Send</span>
        </Button>
      </div>
    </div>
  );
}

const time = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
