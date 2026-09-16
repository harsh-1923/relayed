// Who a chip names, on hover: their face, name and handle, and a way to message
// them. Wraps whatever draws the name — a mention in a message, a person in a
// document — so every place an actor is named behaves the same. A face alone
// asks for it through `ActorAvatar`'s `profileOnHover`; a chip wraps itself, so
// hovering its name opens the card as well as hovering its face.
//
// Not shown: email. It is kept out of the directory on purpose (DESIGN.md
// §6.3 — it lives in WorkOS and is never replicated), so showing it needs a
// decision about carrying it, not just a field here.
import type { ReactElement } from 'react';
import { ChatDefault } from '@relayed/icons';
import { useSession } from '@/app/state';
import { ActorAvatar } from '@/components/ActorAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { useOpenDm } from '@/features/dms/useOpenDm';
import { useActor } from '@/lib/actors';

/** Long enough that moving the pointer across a sentence opens nothing. */
const OPEN_DELAY_MS = 500;

export function ActorHoverCard({ actorId, fallbackName, children }: {
  actorId: string;
  /** Shown while the directory has not got the actor yet — a mention's typed label. */
  fallbackName?: string;
  /** The chip. Rendered as the trigger, so it must accept a ref and props (a DOM element). */
  children: ReactElement;
}) {
  return (
    <HoverCard>
      <HoverCardTrigger delay={OPEN_DELAY_MS} render={children} />
      <HoverCardContent side="top" align="start" className="w-72">
        <ActorProfile actorId={actorId} fallbackName={fallbackName} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** Mounted only while the card is open, so a page of chips holds no DM state. */
function ActorProfile({ actorId, fallbackName }: { actorId: string; fallbackName?: string | undefined }) {
  const actor = useActor(actorId);
  const { state } = useSession();
  const { open, opening, failure, offline } = useOpenDm();
  const me = state.workspaces.find(row => row.workspaceId === state.workspaceId)?.actorId;
  // A local room's actors live in no workspace, and there is nobody to message
  // in one's own face.
  const mayMessage = actor !== undefined && actor.workspaceId !== 'local'
    && actor.id !== me && actor.state === 'active';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <ActorAvatar id={actorId} fallbackName={fallbackName} className="size-10" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{actor?.displayName ?? fallbackName ?? 'Someone'}</div>
          {actor && <div className="truncate text-xs text-muted-foreground">@{actor.handle}</div>}
        </div>
        {actor?.type === 'agent' && <Badge variant="outline">agent</Badge>}
        {actor && actor.state !== 'active' && <Badge variant="secondary">{actor.state}</Badge>}
      </div>
      {actor?.agent?.description && (
        <p className="line-clamp-3 text-xs text-muted-foreground">{actor.agent.description}</p>
      )}
      {mayMessage && (
        <Button
          size="sm" variant="outline"
          disabled={opening || offline}
          title={offline ? 'Starting a conversation needs a connection' : undefined}
          onClick={() => { void open([actorId]); }}
        >
          <ChatDefault />
          {opening ? 'Opening…' : 'Message'}
        </Button>
      )}
      {failure && <p role="alert" className="text-xs text-destructive">{failure}</p>}
    </div>
  );
}
