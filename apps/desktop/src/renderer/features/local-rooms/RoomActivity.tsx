// Whether Claude is replying anywhere in a local room, for the space header.
import { Spinner } from '@/components/ui/spinner';
import { useQuery } from '@/lib/query';

export function RoomActivity({ spaceId }: { spaceId: string }) {
  const { rows } = useQuery('local.rooms.get', { spaceId });
  if (!rows?.[0]?.busy) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" role="status">
      <Spinner className="size-3" /> Claude is working
    </span>
  );
}
