// One local room in the sidebar, and the ways to name it (docs/LOCAL-ROOMS.md §7.1).
//
// Double-click the row, or choose Rename from its context menu, to type a name;
// Enter or leaving the field keeps it, Escape puts the old one back. Regenerate
// name asks for a new one from the conversation so far.
import { useState } from 'react';
import type { LocalRoom } from '../../../preload/api';
import { SidebarItem } from '@/components/SidebarItem';
import { iconForDestination } from '@/lib/navigation/destinations/destination-icon.ts';
import { localRoomDestination } from '@/lib/navigation/destinations/destinations.ts';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { SidebarMenuItem } from '@/components/ui/sidebar';
import { call } from '@/lib/ipc';

export function LocalRoomRow({ room, active }: { room: LocalRoom; active: boolean }) {
  const destination = localRoomDestination(room);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(room.name);
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startRename = () => {
    setDraft(room.name);
    setError(null);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const name = draft.trim();
    if (!name || name === room.name) return;
    void call(api => api.query('local.rooms.rename', { spaceId: room.id, name }))
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); });
  };

  const regenerate = () => {
    setNaming(true);
    setError(null);
    void call(api => api.query('local.rooms.regenerateTitle', { spaceId: room.id }))
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { setNaming(false); });
  };

  if (editing) {
    return (
      <SidebarMenuItem>
        <Input
          autoFocus
          aria-label="Room name"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onFocus={event => event.target.select()}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); commit(); }
            if (event.key === 'Escape') { event.preventDefault(); setEditing(false); }
          }}
          className="h-9 px-2 text-[15px]"
        />
      </SidebarMenuItem>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={(
          <SidebarItem
            label={destination.label}
            icon={iconForDestination(destination)}
            to={destination.to}
            isActive={active}
            labelClassName={naming ? 'shimmer' : undefined}
            title={error ?? undefined}
            onDoubleClick={startRename}
          />
        )}
      />
      <ContextMenuContent>
        <ContextMenuItem onClick={startRename}>Rename</ContextMenuItem>
        <ContextMenuItem onClick={regenerate} disabled={naming}>{naming ? 'Naming…' : 'Regenerate name'}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
