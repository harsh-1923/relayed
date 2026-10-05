// Who is typing, drawn where their next message will land (docs/ACTIVITY.md
// §7): a bubble of three dots beside the typist's face, as a message from
// them would sit. Ephemeral — rendered entirely from `useTypists`, and gone
// the moment they stop, send, or their entry expires.
import { useEffect, useState } from 'react';
import { ActorAvatar } from '@/components/ActorAvatar';
import { AvatarGroup, AvatarGroupCount } from '@/components/ui/avatar';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Message, MessageAvatar, MessageContent } from '@/components/ui/message';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useActorLookup } from '@/lib/actors';
import { useTypists } from '@/lib/activity/use-activity';
import './typing-bubble.css';

/** Faces drawn before the rest become `+N` (§7.2). */
const FACES = 3;
/** A single stray keystroke should not flash a bubble (§7.3). */
const SHOW_AFTER_MS = 300;

export function TypingBubble({ chatId, threadId = null }: { chatId: string; threadId?: string | null }) {
  const typists = useTypists(chatId, threadId);
  const lookup = useActorLookup();
  const anyone = typists.length > 0;
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!anyone) { setShown(false); return; }
    const timer = setTimeout(() => { setShown(true); }, SHOW_AFTER_MS);
    return () => { clearTimeout(timer); };
  }, [anyone]);

  if (!anyone || !shown) return null;

  const names = typists.map(id => lookup(id)?.displayName ?? 'Someone');
  const label = describe(names);
  const extra = typists.length - FACES;

  return (
    // A plain child of the scroller's content, as `Approvals` is: it is not a
    // message, has no id to address, and must not be anchored to.
    <div role="status" aria-live="polite" aria-label={label} className="animate-in fade-in duration-200">
      <Message align="start">
        <Tooltip>
          <TooltipTrigger delay={300} render={<MessageAvatar className="size-7 min-w-0 overflow-visible bg-transparent" />}>
            {typists.length === 1
              ? <ActorAvatar id={typists[0]} className="size-7" fallbackClassName="text-[10px]" />
              : (
                <AvatarGroup className="-space-x-3">
                  {typists.slice(0, FACES).map(id => (
                    <ActorAvatar key={id} id={id} className="size-7" fallbackClassName="text-[10px]" />
                  ))}
                  {extra > 0 && <AvatarGroupCount className="size-7 text-[10px]">+{extra}</AvatarGroupCount>}
                </AvatarGroup>
              )}
          </TooltipTrigger>
          <TooltipContent side="top">{label}</TooltipContent>
        </Tooltip>
        <MessageContent>
          <Bubble variant="muted" align="start">
            <BubbleContent className="flex h-9 items-center gap-1 px-3.5" aria-hidden>
              <Dot delay="0ms" />
              <Dot delay="160ms" />
              <Dot delay="320ms" />
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="typing-dot size-1.5 bg-muted-foreground"
      style={{ animationDelay: delay }}
    />
  );
}

/** "Alice is typing", "Alice and Bob are typing", "Alice, Bob and 2 others are typing". */
export function describe(names: readonly string[]): string {
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others are typing`;
}
