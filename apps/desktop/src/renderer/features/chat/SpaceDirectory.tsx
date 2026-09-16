// The spaces this actor is in, grouped by what kind of space they are.
//
// SPACES, not channels, and the name is load-bearing. `spaces` is one table
// discriminated by `kind` — `channel | dm | group_dm | room` in both schemas —
// and a "room" is one of those four, the one that holds several chats
// (DESIGN.md §7.1). Calling the whole directory a room directory would put the
// code at odds with the schema it reads and the document that settles it.
//
// Read from the replica through the live-query client, so joining a space or
// having a channel created around you repaints without a reload — the loop that
// `chat.created` and `space.member_added` invalidate `spaces` for.
//
// Channels, rooms and direct messages keep their creation controls even when
// empty — Direct messages' opens the new-message dialog, which starts a group
// message too. Group messages appear only once there is one to show.
//
// Deliberately flat within a section. Every space is one destination; rooms
// enter through their default chat and keep their other chats inside the room.
import { useState } from 'react';
import { can, workspace as workspaceTarget } from '@relayed/authz';
import { PlusDefault } from '@relayed/icons';
import { useSession } from '@/app/state';
import { WORKSPACE_SPACE_GROUPS } from '@/lib/navigation/destinations/destinations.ts';
import { grantsOf } from '@/lib/ipc';
import { CreateSpaceDialog } from './CreateSpaceDialog.tsx';
import { SpaceDirectoryRow } from './SpaceDirectoryRow.tsx';
import { NewMessageDialog } from '../dms/NewMessageDialog';
import { useQuery } from '@/lib/query';
import {
  SidebarGroup, SidebarGroupAction, SidebarGroupLabel, SidebarMenu,
} from '@/components/ui/sidebar';

/**
 * The sections, in the order they appear.
 *
 * An array rather than a map, because the ORDER is part of the answer and a map
 * would leave it to whatever the runtime feels like. `kind` values are the
 * schema's, spelled here exactly once.
 */
export function SpaceDirectory() {
  const { rows: spaces, status, error } = useQuery('spaces.list');
  const { state } = useSession();
  const [creating, setCreating] = useState<{ kind: 'channel' | 'room'; workspaceId: string } | null>(null);
  const [messaging, setMessaging] = useState<string | null>(null);
  const mayCreate = state.workspaceId !== null && can(grantsOf(state), 'create_space', workspaceTarget(state.workspaceId));

  if (status === 'loading') {
    return <p className="px-4 py-2 text-sm text-muted-foreground">Reading…</p>;
  }

  return (
    <>
      {error && <p role="alert" className="px-4 py-2 text-sm text-destructive">Could not read channels and rooms.</p>}
      {status === 'empty' && !mayCreate && <p className="px-4 py-2 text-sm text-muted-foreground">Nothing here yet.</p>}
      {WORKSPACE_SPACE_GROUPS.map(section => {
        const mine = (spaces ?? []).filter(space => space.kind === section.kind);
        const creatable = section.kind === 'channel' || section.kind === 'room';
        const startable = section.kind === 'dm';
        if (mine.length === 0 && !((creatable || startable) && mayCreate)) return null;
        return (
          <SidebarGroup key={section.kind}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            {creatable && mayCreate && (
              <SidebarGroupAction
                title={state.offline ? 'Creating needs a connection' : `Create ${section.kind}`}
                aria-label={`Create ${section.kind}`}
                disabled={state.offline}
                onClick={() => setCreating({ kind: section.kind as 'channel' | 'room', workspaceId: state.workspaceId! })}
              >
                <PlusDefault />
              </SidebarGroupAction>
            )}
            {startable && mayCreate && (
              <SidebarGroupAction
                title={state.offline ? 'Starting a conversation needs a connection' : 'New message'}
                aria-label="New message"
                disabled={state.offline}
                onClick={() => setMessaging(state.workspaceId)}
              >
                <PlusDefault />
              </SidebarGroupAction>
            )}
            {mine.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">No {section.label.toLowerCase()} yet.</p>}
            <SidebarMenu className="space-y-0.5">
              {mine.map(space => (
                <SpaceDirectoryRow key={space.id} space={space} />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        );
      })}
      {messaging && messaging === state.workspaceId && (
        <NewMessageDialog key={messaging} onClose={() => setMessaging(null)} />
      )}
      {creating && creating.workspaceId === state.workspaceId && (
        <CreateSpaceDialog key={`${creating.workspaceId}:${creating.kind}`} {...creating} onClose={() => setCreating(null)} />
      )}
    </>
  );
}
