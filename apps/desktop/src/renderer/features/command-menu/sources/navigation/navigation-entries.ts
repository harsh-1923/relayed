// The sidebar's destinations, with the words each is found by, in sidebar
// order. Free of React so aliases and ordering run under node:test.
import type { LocalRoom } from '../../../../../shared/local-rooms.ts';
import type { Space } from '../../../../../shared/spaces.ts';
import {
  localRoomDestination, primaryDestinationsFor, WORKSPACE_SPACE_GROUPS,
  workspaceSpaceDestination, type NavigationDestination,
} from '../../../../lib/navigation/destinations/destinations.ts';

export interface NavigationEntry {
  readonly destination: NavigationDestination;
  readonly keywords: readonly string[];
  readonly detail: string | null;
}

const PRIMARY_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  People: ['members'],
  Connectors: ['integrations', 'apps'],
};

const SPACE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  channel: ['channel'],
  room: ['room', 'shared room'],
  group_dm: ['group message', 'group dm'],
  dm: ['direct message', 'dm'],
};

export function navigationEntriesFor(
  workspaceId: string | null,
  spaces: readonly Space[],
  localRooms: readonly LocalRoom[],
): NavigationEntry[] {
  // The sidebar itself needs an active workspace, even though its first
  // section holds account-tier local rooms; the menu follows it.
  if (workspaceId === null) return [];

  const entries: NavigationEntry[] = [
    ...primaryDestinationsFor(workspaceId).map(destination => ({
      destination,
      keywords: [destination.label, ...(PRIMARY_KEYWORDS[destination.label] ?? [])],
      detail: null,
    })),
    ...localRooms.map(room => {
      const folder = folderName(room.cwd);
      return {
        destination: localRoomDestination(room),
        keywords: [room.name, 'local room', 'room', folder, room.cwd],
        detail: folder,
      };
    }),
  ];
  for (const section of WORKSPACE_SPACE_GROUPS) {
    for (const space of spaces) {
      if (space.kind !== section.kind) continue;
      const destination = workspaceSpaceDestination(workspaceId, space);
      if (!destination) continue;
      entries.push({
        destination,
        keywords: [space.name, ...(SPACE_ALIASES[space.kind] ?? []), ...(space.slug ? [space.slug] : [])],
        detail: null,
      });
    }
  }
  return entries;
}

function folderName(cwd: string): string {
  return cwd.replace(/\/+$/, '').split('/').at(-1) || cwd;
}
