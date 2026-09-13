// The top of a local room's chat: which room, and which folder Claude works in.
// A room about a directory should say which one (docs/LOCAL-ROOMS.md §7). Its
// mode is chosen in the composer, beside where the person asks (RoomModePicker).
import { FolderDefault } from '@relayed/icons';
import { Spinner } from '@/components/ui/spinner';
import { useQuery } from '@/lib/query';

export function LocalRoomHeader({ chatId }: { chatId: string }) {
  const { rows: rooms } = useQuery('local.rooms.list');
  const room = rooms?.find(candidate => candidate.chats.some(chat => chat.id === chatId));
  if (!room) return null;

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-6 py-2.5">
      <FolderDefault className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{room.name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground" title={room.cwd}>{room.cwd}</p>
      </div>
      {room.busy && (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Spinner className="size-3" /> Claude is working
        </span>
      )}
    </div>
  );
}
