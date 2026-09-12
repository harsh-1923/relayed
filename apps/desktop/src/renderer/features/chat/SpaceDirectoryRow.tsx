// One space in the directory. Every kind is one row; a room enters through its
// default chat rather than exposing its chat hierarchy in the global sidebar.
import { useParams } from 'react-router';
import { ChatDefault, Hashtag, LockClose, UserTwo } from '@relayed/icons';
import type { ReplicaSpace } from '../../../preload/api';
import { SidebarItem } from '@/components/SidebarItem';

export function SpaceDirectoryRow({ space }: { space: ReplicaSpace }) {
  // `chatId` from the URL rather than NavLink's own active state: the sidebar
  // component styles its rows off `data-active`, which `isActive` sets, and two
  // sources of "this row is selected" is one too many.
  const { wsId, chatId } = useParams();
  const label = space.name ?? space.slug ?? 'space';
  const Icon = iconFor(space);

  // `default` is the room's common floor; `sole` is the structural chat for
  // every other space kind. The fallback keeps incomplete development fixtures
  // visible without inventing a second navigation shape.
  const entryChat = space.chats.find(chat => chat.kind === 'default')
    ?? space.chats.find(chat => chat.kind === 'sole' || chat.kind === 'main')
    ?? space.chats[0];
  const mentions = space.chats.reduce((sum, chat) => sum + chat.mentions, 0);
  const holdsOpenChat = space.chats.some(chat => chat.id === chatId);

  return (
    <SidebarItem
      label={label}
      icon={Icon}
      to={entryChat ? `/w/${wsId}/c/${entryChat.id}` : undefined}
      isActive={holdsOpenChat}
      badge={mentions}
      disabled={!entryChat}
    />
  );
}

/** Private is a padlock regardless of kind; the rest say what they are. */
function iconFor(space: ReplicaSpace) {
  if (space.kind === 'dm') return ChatDefault;
  if (space.kind === 'group_dm') return UserTwo;
  return space.visibility === 'public' ? Hashtag : LockClose;
}
