// Every place the sidebar lists, opened from the menu.
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '@/app/state';
import { iconForDestination } from '@/lib/navigation/destinations/destination-icon.ts';
import { NAVIGATION_GROUPS } from '@/lib/navigation/destinations/destinations.ts';
import { useQuery } from '@/lib/query';
import type { CommandMenuItem } from '../../command-menu-context.ts';
import { CommandMenuGroup } from '../../CommandMenuRow.tsx';
import { navigationEntriesFor } from './navigation-entries.ts';

export function NavigationSource() {
  // From state, not the URL: a local room's route has no workspace in its path.
  const workspaceId = useSession().state.workspaceId;
  const navigate = useNavigate();
  // Sources mount only while the menu is open. The reads are local and shared
  // with a mounted sidebar through the registry, and nothing stays subscribed
  // behind a closed menu.
  const spaces = useQuery('spaces.list');
  const localRooms = useQuery('local.rooms.list');

  const groups = useMemo(() => {
    const entries = navigationEntriesFor(workspaceId, spaces.rows ?? [], localRooms.rows ?? []);
    return NAVIGATION_GROUPS.map(group => ({
      ...group,
      items: entries
        .filter(entry => entry.destination.group === group.id)
        .map(({ destination, keywords, detail }): CommandMenuItem => ({
          id: `nav:${destination.id}`,
          label: destination.label,
          icon: iconForDestination(destination),
          keywords,
          detail,
          disabled: destination.disabled,
          perform: () => void navigate(destination.to),
        })),
    }));
  }, [workspaceId, spaces.rows, localRooms.rows, navigate]);

  const loading = (spaces.status === 'loading' && spaces.error === null)
    || (localRooms.status === 'loading' && localRooms.error === null);
  const readFailed = spaces.error !== null || localRooms.error !== null;

  return (
    <>
      {loading ? (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Reading spaces…</p>
      ) : readFailed ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          Some spaces could not be read. Showing what is available.
        </p>
      ) : null}
      {groups.map(group => <CommandMenuGroup key={group.id} heading={group.label} items={group.items} />)}
    </>
  );
}
