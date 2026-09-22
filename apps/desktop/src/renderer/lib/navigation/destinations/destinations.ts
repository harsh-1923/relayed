// The places the app can open, as the sidebar and the command menu both show
// them.
//
// Navigation facts live here rather than being rebuilt by each surface. A row
// with a route in the sidebar and a search result with another route is worse
// than a missing result: both look valid, and only one returns to the same
// place. How a destination is searched for belongs to the command menu, not
// here. Free of React so its routes and partially-hydrated state run under
// node:test.
import type { LocalRoom } from '../../../../shared/local-rooms.ts';
import { mainChat, type Space } from '../../../../shared/spaces.ts';

export const WORKSPACE_SPACE_GROUPS = [
  { id: 'channel', kind: 'channel', label: 'Channels' },
  { id: 'room', kind: 'room', label: 'Rooms' },
  { id: 'group_dm', kind: 'group_dm', label: 'Group messages' },
  { id: 'dm', kind: 'dm', label: 'Direct messages' },
] as const;

/** Every group, in the order the sidebar shows them. */
export const NAVIGATION_GROUPS = [
  { id: 'go-to', label: 'Go to' },
  { id: 'local-room', label: 'Local rooms' },
  ...WORKSPACE_SPACE_GROUPS,
] as const;

export type NavigationGroupId = (typeof NAVIGATION_GROUPS)[number]['id'];
export type NavigationIcon = 'agents' | 'apps' | 'chat' | 'group' | 'hashtag' | 'lock' | 'people';

export interface NavigationDestination {
  /** Stable and unique. Labels are not unique. */
  id: string;
  label: string;
  group: NavigationGroupId;
  icon: NavigationIcon;
  to: string;
  disabled: boolean;
}

/** Workspace-tier destinations pinned above the space directory. */
export function primaryDestinationsFor(workspaceId: string | null): NavigationDestination[] {
  if (workspaceId === null) return [];
  return [
    {
      id: `p:${workspaceId}:people`,
      label: 'People',
      group: 'go-to',
      icon: 'people',
      to: `/w/${workspaceId}/people?tab=humans`,
      disabled: false,
    },
    {
      // The same route as People, opened on its Agents tab. The directory is
      // one list of actors; which kind you came looking for is a tab, and the
      // tab lives in the URL so this row can point at it.
      id: `p:${workspaceId}:agents`,
      label: 'Agents',
      group: 'go-to',
      icon: 'agents',
      to: `/w/${workspaceId}/people?tab=agents`,
      disabled: false,
    },
    {
      id: `p:${workspaceId}:apps`,
      label: 'Apps',
      group: 'go-to',
      icon: 'apps',
      to: `/w/${workspaceId}/apps`,
      disabled: false,
    },
  ];
}

/** The installed-app management view, offered by navigation search but not pinned in the sidebar. */
export function installedAppsDestination(workspaceId: string): NavigationDestination {
  return {
    id: `p:${workspaceId}:apps:installed`,
    label: 'Installed apps',
    group: 'go-to',
    icon: 'apps',
    to: `/w/${workspaceId}/apps/installed`,
    disabled: false,
  };
}

/** One workspace space, or null when the sidebar has no section for its kind. */
export function workspaceSpaceDestination(
  workspaceId: string | null,
  space: Space,
): NavigationDestination | null {
  if (workspaceId === null) return null;
  const group = workspaceGroup(space.kind);
  if (!group) return null;

  return {
    id: `s:${workspaceId}:${space.id}`,
    label: space.name,
    group: group.id,
    icon: iconForWorkspaceSpace(space),
    to: `/w/${workspaceId}/s/${space.id}`,
    // A space with no sole/default chat has not finished arriving. It remains
    // visible everywhere but nothing may promise that it opens yet.
    disabled: mainChat(space) === null,
  };
}

/** One account-tier local room. */
export function localRoomDestination(room: LocalRoom): NavigationDestination {
  return {
    id: `l:${room.id}`,
    label: room.name,
    group: 'local-room',
    icon: 'chat',
    to: `/local/s/${room.id}`,
    disabled: false,
  };
}

function workspaceGroup(kind: string): (typeof WORKSPACE_SPACE_GROUPS)[number] | null {
  return WORKSPACE_SPACE_GROUPS.find(group => group.kind === kind) ?? null;
}

function iconForWorkspaceSpace(space: Space): NavigationIcon {
  if (space.kind === 'dm') return 'chat';
  if (space.kind === 'group_dm') return 'group';
  return space.visibility === 'public' ? 'hashtag' : 'lock';
}
