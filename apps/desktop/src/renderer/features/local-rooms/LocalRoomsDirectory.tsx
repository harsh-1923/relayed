// Local rooms in the sidebar: rooms on this Mac, driven by the person's own
// Claude Code, above the workspace's spaces (docs/LOCAL-ROOMS.md §7).
//
// Always shown, whichever workspace is open — local rooms are account-tier and
// a workspace switch does not touch them. Rooms are grouped under the folder
// they were opened on, each folder a collapsible row; a room enters through its
// default chat, as a synced room does.
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ChevronRight, FolderDefault, PlusDefault } from '@relayed/icons';
import type { LocalRoom } from '../../../preload/api';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  SidebarGroup, SidebarGroupAction, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub,
} from '@/components/ui/sidebar';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/query';
import { LocalRoomRow } from './LocalRoomRow';

export function LocalRoomsDirectory() {
  const { rows: rooms } = useQuery('local.rooms.list');
  const { spaceId } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // Folders collapsed by hand this session. Everything starts open.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());

  // Arriving at a room — from a link, the palette, a new room — opens its folder
  // once; after that the person can close it again.
  const activeFolder = rooms?.find(room => room.id === spaceId)?.cwd;
  useEffect(() => {
    if (activeFolder) setClosed(prev => toggled(prev, activeFolder, false));
  }, [activeFolder, spaceId]);

  const create = () => {
    setError(null);
    void (async () => {
      try {
        const created = await call(api => api.query('local.rooms.create'));
        if (created) void navigate(`/local/s/${created.spaceId}`);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  };

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Local rooms</SidebarGroupLabel>
      <SidebarGroupAction title="New local room — choose a folder" onClick={create}>
        <PlusDefault />
        <span className="sr-only">New local room</span>
      </SidebarGroupAction>
      <SidebarMenu className="space-y-0.5">
        {byFolder(rooms ?? []).map(folder => (
          <Collapsible
            key={folder.cwd}
            open={!closed.has(folder.cwd)}
            onOpenChange={open => { setClosed(prev => toggled(prev, folder.cwd, !open)); }}
            render={<SidebarMenuItem />}
          >
            <CollapsibleTrigger
              render={<SidebarMenuButton />}
              title={folder.cwd}
              className="group/folder h-9 gap-2.5 px-2 text-[15px] text-(--sidebar-item-foreground)
                         hover:bg-(--sidebar-item-background)! hover:text-(--sidebar-item-foreground)!"
            >
              <FolderDefault className="size-4" />
              <span className="truncate">{folder.name}</span>
              <ChevronRight className="ml-auto size-3.5 opacity-60 transition-transform group-data-[panel-open]/folder:rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub>
                {folder.rooms.map(room => (
                  <LocalRoomRow key={room.id} room={room} active={room.id === spaceId} />
                ))}
              </SidebarMenuSub>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </SidebarMenu>
      {rooms?.length === 0 && (
        <p className="px-2 py-1 text-xs text-muted-foreground">Open a folder to talk to your Claude Code about it.</p>
      )}
      {error && <p className="px-2 py-1 text-xs text-destructive">{error}</p>}
    </SidebarGroup>
  );
}

interface Folder { cwd: string; name: string; rooms: LocalRoom[] }

/** Rooms grouped by folder, in the order the rooms arrive (most recent first). */
function byFolder(rooms: readonly LocalRoom[]): Folder[] {
  const folders = new Map<string, Folder>();
  for (const room of rooms) {
    let folder = folders.get(room.cwd);
    if (!folder) {
      folder = { cwd: room.cwd, name: room.cwd.replace(/\/+$/, '').split('/').at(-1) || room.cwd, rooms: [] };
      folders.set(room.cwd, folder);
    }
    folder.rooms.push(room);
  }
  return [...folders.values()];
}

function toggled(set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (on) next.add(key); else next.delete(key);
  return next;
}
