// One space in the directory. Every kind is one row; a room enters through its
// default chat rather than exposing its chat hierarchy in the global sidebar.
import { useMemo } from 'react';
import { useParams } from 'react-router';
import type { Space } from '../../../preload/api';
import { ActorAvatar } from '@/components/ActorAvatar';
import { SidebarItem } from '@/components/SidebarItem';
import { useSession } from '@/app/state';
import { iconForDestination } from '@/lib/navigation/destinations/destination-icon.ts';
import { workspaceSpaceDestination } from '@/lib/navigation/destinations/destinations.ts';
import { cn } from '@/lib/utils';

export function SpaceDirectoryRow({ space }: { space: Space }) {
  // `spaceId` from the URL rather than NavLink's own active state: the sidebar
  // component styles its rows off `data-active`, which `isActive` sets, and two
  // sources of "this row is selected" is one too many.
  const { spaceId } = useParams();
  // The ACTIVE workspace, not the URL's: on a local room's route there is no
  // `wsId` in the path, and the directory still belongs to this workspace.
  const { state } = useSession();
  const wsId = state.workspaceId;
  const destination = workspaceSpaceDestination(wsId, space);
  const me = state.workspaces.find(row => row.workspaceId === wsId)?.actorId;
  // A DM shows the other person's face; a DM with yourself shows yours.
  const other = space.kind === 'dm'
    ? (space.memberIds?.find(id => id !== me) ?? space.memberIds?.[0] ?? null)
    : null;
  // Memoised on the id: a component type made fresh each render would remount
  // the avatar every time the sidebar re-rendered.
  const dmIcon = useMemo(() => {
    if (!other) return null;
    const DmAvatar = ({ className }: { className?: string }) => (
      <ActorAvatar id={other} className={cn(className, 'size-5 -mx-0.5')} fallbackClassName="text-[9px]" />
    );
    return DmAvatar;
  }, [other]);

  if (!destination) return null;

  const mentions = space.chats.reduce((sum, chat) => sum + chat.mentions, 0);

  return (
    <SidebarItem
      label={destination.label}
      icon={dmIcon ?? iconForDestination(destination)}
      to={destination.to}
      isActive={space.id === spaceId}
      badge={mentions}
      disabled={destination.disabled}
    />
  );
}
