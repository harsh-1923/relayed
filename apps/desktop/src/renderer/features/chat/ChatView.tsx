// One chat: its messages, and somewhere to type. The main pane of a space, and
// the body of a chat panel beside it (PANELS.md §4).
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
// ONE VIEW, TWO SCOPES (LOCAL-ROOMS.md §11). A local room's chat is read and
// written through the local store instead of the replica, and the rows are the
// same shape, so the difference is which read and which send — named once, in
// READS below; the composer owns the matching draft and send operations.
//
// SCROLLING IS THE SCROLLER'S, not ours. A first version used an overflow div
// and a `scrollIntoView` on a ref, which is the hand-rolled stick-to-bottom the
// primitive exists to replace — it does the anchoring, the position restore and
// the jump-to-latest, and it yields the moment somebody scrolls up.
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useQuery } from '@/lib/query';
import { useSession } from '@/app/state';
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent,
  MessageScrollerProvider, MessageScrollerViewport, useMessageScroller,
  useMessageScrollerScrollable,
} from '@/components/ui/message-scroller';
import { ChatBubble } from '@/features/chat/ChatBubble';
import { SystemMarker } from '@/features/chat/SystemMarker';
import { MessageComposer } from '@/features/chat/composer/MessageComposer';
import { Approvals } from '@/features/local-rooms/Approvals';
import { RoomModelPicker } from '@/features/local-rooms/RoomModelPicker';
import { RoomModePicker } from '@/features/local-rooms/RoomModePicker';
import { useRoomSlashCommands } from '@/features/local-rooms/useRoomSlashCommands';
import { useChatActivity } from '@/lib/agent-activity';
import { RunIndicator } from '@/features/agents/RunIndicator';
import type { SpaceScope } from '../../../shared/spaces.ts';

/** The message read, and what an empty chat says, by storage scope. */
const READS = {
  workspace: { list: 'messages.list', empty: 'Nothing here yet. Say something — it is written to this device first.' },
  local: { list: 'local.messages.list', empty: 'Ask Claude anything about this folder. It runs as your own Claude Code, here on this Mac.' },
} as const;

export function ChatView({ spaceId, chatId, scope }: { spaceId: string; chatId: string; scope: SpaceScope }) {
  const { state } = useSession();
  const me = scope === 'local'
    ? 'act_local_me'
    : state.workspaces.find(w => w.workspaceId === state.workspaceId)?.actorId;

  // Both reads take `{ chatId }` and return the same rows; the cast names one of
  // them for the type checker, which cannot follow a key chosen at runtime.
  const { rows: messages, status } = useQuery(READS[scope].list as 'messages.list', { chatId });
  const replying = (messages ?? []).some(message => message.state === 'streaming');
  // The replies paused on the person. Always read, for one hook order in both
  // scopes; a workspace chat has no local approvals and gets none.
  const { rows: approvals } = useQuery('local.approvals.list', { chatId: scope === 'local' ? chatId : '' });
  // Workspace agents only (WORKSPACE-AGENTS.md §5.7) — a local room's own
  // Claude Code has no `agent_runs` row and never pushes this.
  const activity = useChatActivity(scope === 'workspace' ? chatId : '');

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
            {/* One reading column: on a wide window, turns stay near each other
                instead of pinned to opposite edges. The composer shares it. */}
            <MessageScrollerContent className="mx-auto w-full max-w-4xl p-6">
              {status === 'loading' && (
                <p className="text-sm text-muted-foreground">Reading…</p>
              )}
              {status === 'empty' && (
                <p className="text-sm text-muted-foreground">{READS[scope].empty}</p>
              )}

              {(messages ?? []).map((message, index, allMessages) => {
                // History, not authored conversation: no sender, no grouping,
                // no bubble (SPACE-MEMBERSHIP-MARKERS.md). A direct
                // `MessageScrollerContent` child, same as `ChatBubble`, so the
                // scroller's anchoring and addressing still hold.
                if (message.kind === 'system') {
                  return <SystemMarker key={message.id} message={message} />;
                }

                const mine = message.authorId === me;
                const previousMessage = allMessages[index - 1];
                const nextMessage = allMessages[index + 1];
                return (
                  // A Fragment, not a wrapping element: `ChatBubble`'s
                  // `MessageScrollerItem` must stay a direct child of
                  // `MessageScrollerContent` for the scroller's own anchoring —
                  // `Approvals` below is already a plain sibling for the same
                  // reason.
                  <Fragment key={message.id}>
                    <ChatBubble
                      message={message}
                      mine={mine}
                      // A marker breaks a sender group on both sides — it is
                      // never itself grouped, and neither is its neighbour.
                      startsGroup={previousMessage?.authorId !== message.authorId
                        || previousMessage?.kind === 'system'}
                      endsGroup={nextMessage?.authorId !== message.authorId
                        || nextMessage?.kind === 'system'}
                      waiting={approvals?.some(approval => approval.messageId === message.id) ?? false}
                    />
                    {/* Attached to the trigger, whose thread this is (§5.7). Gates
                        Stop on `mine` — the common case, a fresh top-level
                        mention, where the trigger IS the thread root; a mention
                        added to an existing thread can show Stop to that
                        thread's starter rather than the actual invoker, a narrow
                        misattribution accepted for now. */}
                    {activity.filter(run => run.threadId === message.id).map(run => (
                      <RunIndicator key={run.runId} run={run} isInvoker={mine} />
                    ))}
                  </Fragment>
                );
              })}

              {/* What a paused reply is waiting on, where the reply is. */}
              {scope === 'local' && <Approvals chatId={chatId} />}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>

        <ComposerAtLiveEdge spaceId={spaceId} chatId={chatId} scope={scope} replying={replying} />
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

function ComposerAtLiveEdge({ spaceId, ...props }: { spaceId: string; chatId: string; scope: SpaceScope; replying: boolean }) {
  const { scrollToEnd } = useMessageScroller();
  const local = props.scope === 'local';
  // Open from the model button, or from /model and /effort in the composer.
  const [modelMenu, setModelMenu] = useState(false);
  const openModelMenu = useCallback(() => setModelMenu(true), []);
  const slash = useRoomSlashCommands(local ? spaceId : undefined, local ? props.chatId : undefined, openModelMenu);
  return (
    <MessageComposer
      {...props}
      spaceId={spaceId}
      onSent={() => scrollToEnd({ behavior: 'smooth' })}
      approvalControl={local ? className => <RoomModePicker spaceId={spaceId} className={className} /> : undefined}
      modelControl={local
        ? className => <RoomModelPicker spaceId={spaceId} className={className} open={modelMenu} onOpenChange={setModelMenu} />
        : undefined}
      {...(slash ? { slash } : {})}
    />
  );
}
