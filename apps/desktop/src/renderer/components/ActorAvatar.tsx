// An actor's face by id: their avatar held locally, or — for an agent — a face
// generated from their id, or their initials until one arrives. Sized by the
// caller through `className`. `profileOnHover` puts the actor's hover card on
// it (`ActorHoverCard`) — off unless a surface asks, since a face inside a
// picker row or a link already has a click of its own.
//
// AGENTS GET A DRAWN FACE, PEOPLE GET INITIALS. An agent has no photograph to
// be waiting for: initials were a placeholder for something that was never
// going to arrive, so every agent in the app was a grey disc with two letters
// in it. A generated face is deterministic from the id, needs no network and no
// stored blob, and is the same on every device forever.
//
// An avatar someone actually uploaded still wins. The drawn face is what fills
// the gap, not a replacement for a choice a person made.
import { ActorHoverCard } from '@/components/ActorHoverCard';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EyeAvatar } from '@relayed/avatars/react';
import type { AgentActivity } from '@relayed/avatars';
import { useActor } from '@/lib/actors';
import { blobSrc, initials } from '@/lib/ipc';
import { cn } from '@/lib/utils';

export function ActorAvatar({ id, fallbackName, fallbackBlob, className, fallbackClassName, profileOnHover = false, activity = 'idle', animated = true }: {
  id: string | null | undefined;
  /**
   * Only for an id the directory may not hold — a mention's typed label, say.
   * An actor that came from the directory needs nothing but its id.
   */
  fallbackName?: string;
  /**
   * An avatar the caller already holds, used when the directory has none — an
   * account's own face in a workspace that is not the one open.
   */
  fallbackBlob?: string | null;
  className?: string;
  fallbackClassName?: string;
  /** Show who this is on hover. Off by default. */
  profileOnHover?: boolean;
  /**
   * What this agent is doing, for surfaces that know — a live run, mostly.
   * Ignored for people and for agents with an uploaded avatar.
   *
   * PASSED IN, never read here: run activity is a chat-scoped subscription, and
   * an avatar that opened its own would mean one subscription per face on
   * screen, most of them nowhere near a chat.
   */
  activity?: AgentActivity;
  /**
   * Turn the drawn face's idle motion off. Worth doing on a dense list, where
   * fifty blinking faces are fifty animations nobody asked to watch.
   */
  animated?: boolean;
}) {
  const actor = useActor(id);
  const blob = actor?.avatarBlob ?? fallbackBlob;
  // Only when we KNOW it is an agent. An id the directory has not got yet could
  // be anyone, and drawing a creature for a person would be worse than waiting.
  const drawn = actor?.type === 'agent' && !blob;

  const face = (
    <Avatar className={cn('overflow-hidden', className)}>
      <AvatarImage src={blobSrc(blob)} alt="" />
      <AvatarFallback className={cn(drawn && 'bg-transparent', fallbackClassName)}>
        {drawn
          // Seeded on the id, not the handle: a handle can be renamed, and an
          // agent's face changing because someone tidied its name would be a
          // different agent as far as anyone skimming is concerned.
          ? <EyeAvatar seed={actor.id} activity={activity} animated={animated} className="size-full" />
          : initials(actor?.displayName ?? fallbackName ?? '')}
      </AvatarFallback>
    </Avatar>
  );
  return profileOnHover && id
    ? <ActorHoverCard actorId={id} {...(fallbackName ? { fallbackName } : {})}>{face}</ActorHoverCard>
    : face;
}
