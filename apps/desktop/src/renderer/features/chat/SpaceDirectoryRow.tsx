// One space in the directory. Every kind is one row; a room enters through its
// default chat rather than exposing its chat hierarchy in the global sidebar.
import { useParams } from 'react-router';
import type { Space } from '../../../preload/api';
import { SidebarItem } from '@/components/SidebarItem';
import { useSession } from '@/app/state';
import { iconForDestination } from '@/lib/navigation/destinations/destination-icon.ts';
import { workspaceSpaceDestination } from '@/lib/navigation/destinations/destinations.ts';

export function SpaceDirectoryRow({ space }: { space: Space }) {
  // `spaceId` from the URL rather than NavLink's own active state: the sidebar
  // component styles its rows off `data-active`, which `isActive` sets, and two
  // sources of "this row is selected" is one too many.
  const { spaceId } = useParams();
  // The ACTIVE workspace, not the URL's: on a local room's route there is no
  // `wsId` in the path, and the directory still belongs to this workspace.
  const wsId = useSession().state.workspaceId;
  const destination = workspaceSpaceDestination(wsId, space);

  if (!destination) return null;

  const mentions = space.chats.reduce((sum, chat) => sum + chat.mentions, 0);

  return (
    <SidebarItem
      label={destination.label}
      icon={iconForDestination(destination)}
      to={destination.to}
      isActive={space.id === spaceId}
      badge={mentions}
      disabled={destination.disabled}
    />
  );
}
