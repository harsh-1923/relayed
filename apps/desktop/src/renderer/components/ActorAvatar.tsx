// An actor's face by id: their avatar held locally, or their initials until it
// arrives. Sized by the caller through `className`. `profileOnHover` puts the
// actor's hover card on it (`ActorHoverCard`) — off unless a surface asks, since
// a face inside a picker row or a link already has a click of its own.
import { ActorHoverCard } from '@/components/ActorHoverCard';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useActor } from '@/lib/actors';
import { blobSrc, initials } from '@/lib/ipc';
import { cn } from '@/lib/utils';

export function ActorAvatar({ id, fallbackName, fallbackBlob, className, fallbackClassName, profileOnHover = false }: {
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
}) {
  const actor = useActor(id);
  const face = (
    <Avatar className={cn('overflow-hidden', className)}>
      <AvatarImage src={blobSrc(actor?.avatarBlob ?? fallbackBlob)} alt="" />
      <AvatarFallback className={fallbackClassName}>{initials(actor?.displayName ?? fallbackName ?? '')}</AvatarFallback>
    </Avatar>
  );
  return profileOnHover && id
    ? <ActorHoverCard actorId={id} {...(fallbackName ? { fallbackName } : {})}>{face}</ActorHoverCard>
    : face;
}
