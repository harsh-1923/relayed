// An actor's face by id: their avatar held locally, or their initials until it
// arrives. Sized by the caller through `className`.
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useActor } from '@/lib/actors';
import { blobSrc, initials } from '@/lib/ipc';
import { cn } from '@/lib/utils';

export function ActorAvatar({ id, fallbackName, fallbackBlob, className, fallbackClassName }: {
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
}) {
  const actor = useActor(id);
  return (
    <Avatar className={cn('overflow-hidden', className)}>
      <AvatarImage src={blobSrc(actor?.avatarBlob ?? fallbackBlob)} alt="" />
      <AvatarFallback className={fallbackClassName}>{initials(actor?.displayName ?? fallbackName ?? '')}</AvatarFallback>
    </Avatar>
  );
}
