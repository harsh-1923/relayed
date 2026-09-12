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
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@/lib/query';
import { call } from '@/lib/ipc';
import { useSession } from '@/app/state';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent,
  MessageScrollerProvider, MessageScrollerViewport, useMessageScroller,
  useMessageScrollerScrollable,
} from '@/components/ui/message-scroller';
import { ChatBubble } from '@/features/chat/ChatBubble';
import { SendPlaneHorizontal } from '@relayed/icons';

export function Chat() {
  const { chatId } = useParams();
  const { state } = useSession();
  const me = state.workspaces.find(w => w.workspaceId === state.workspaceId)?.actorId;

  const { rows: messages, status } = useQuery('messages.list', { chatId: chatId ?? '' });

  return (
    // Fills the pane. The shell pads nothing — a route opts into padding by
    // being wrapped in `Page` in the route table, and this one deliberately is
    // not (app/shell/Page.tsx). The first version cancelled the shell's padding with
    // `-m-10` and pinned itself to `h-svh`, which is a layout arguing with
    // itself and was wrong by the height of the top bar the moment one existed.
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageScrollerProvider
        autoScroll
        defaultScrollPosition="end"
        scrollEdgeThreshold={64}
      >
        <FollowAtLiveEdge />
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

              {(messages ?? []).map((message, index, allMessages) => {
                const mine = message.authorId === me;
                const previousMessage = allMessages[index - 1];
                const nextMessage = allMessages[index + 1];
                return (
                  <ChatBubble
                    key={message.id}
                    message={message}
                    mine={mine}
                    startsGroup={previousMessage?.authorId !== message.authorId}
                    endsGroup={nextMessage?.authorId !== message.authorId}
                  />
                );
              })}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>

        <Composer chatId={chatId} />
      </MessageScrollerProvider>
    </div>
  );
}

function FollowAtLiveEdge() {
  const { end: hasContentBelow } = useMessageScrollerScrollable();
  const { scrollToEnd } = useMessageScroller();

  useEffect(() => {
    // The primitive leaves follow mode after any deliberate scroll. Reaching
    // the live edge again is the reader opting back in, as in people-to-people
    // chat: subsequent arrivals should remain visible until they scroll away.
    if (!hasContentBelow) scrollToEnd({ behavior: 'auto' });
  }, [hasContentBelow, scrollToEnd]);

  return null;
}

function Composer({ chatId }: { chatId: string | undefined }) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const { scrollToEnd } = useMessageScroller();

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
      // Sending expresses an intent to return to the live conversation even
      // when the reader had previously scrolled into history. The local write
      // resolves before its live-query repaint, and scrollToEnd also re-engages
      // auto-follow for that incoming optimistic row.
      scrollToEnd({ behavior: 'smooth' });
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
          <SendPlaneHorizontal className="size-4" />
          <span className="sr-only">Send</span>
        </Button>
      </div>
    </div>
  );
}
