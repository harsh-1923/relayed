// One space in the directory. Every kind is one row; a room enters through its
// default chat rather than exposing its chat hierarchy in the global sidebar.
import { useParams } from 'react-router';
import { ChatDefault, Hashtag, LockClose, UserTwo } from '@relayed/icons';
import type { Space } from '../../../preload/api';
import { mainChat } from '../../../shared/spaces.ts';
import { SidebarItem } from '@/components/SidebarItem';
import { useSession } from '@/app/state';

export function SpaceDirectoryRow({ space }: { space: Space }) {
  // `spaceId` from the URL rather than NavLink's own active state: the sidebar
  // component styles its rows off `data-active`, which `isActive` sets, and two
  // sources of "this row is selected" is one too many.
  const { spaceId } = useParams();
  // The ACTIVE workspace, not the URL's: on a local room's route there is no
  // `wsId` in the path, and the directory still belongs to this workspace.
  const wsId = useSession().state.workspaceId;
  const Icon = iconFor(space);

  const mentions = space.chats.reduce((sum, chat) => sum + chat.mentions, 0);

  return (
    <SidebarItem
      label={space.name}
      icon={Icon}
      to={`/w/${wsId}/s/${space.id}`}
      isActive={space.id === spaceId}
      badge={mentions}
      // A space with no chat to open on has not finished arriving.
      disabled={!mainChat(space)}
    />
  );
}

/** Private is a padlock regardless of kind; the rest say what they are. */
function iconFor(space: Space) {
  if (space.kind === 'dm') return ChatDefault;
  if (space.kind === 'group_dm') return UserTwo;
  return space.visibility === 'public' ? Hashtag : LockClose;
}
