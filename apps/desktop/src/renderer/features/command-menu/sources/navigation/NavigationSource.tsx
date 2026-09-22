// Every place the sidebar lists, opened from the menu.
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '@/app/state';
import { iconForDestination } from '@/lib/navigation/destinations/destination-icon.ts';
import { NAVIGATION_GROUPS } from '@/lib/navigation/destinations/destinations.ts';
import { useQuery } from '@/lib/query';
import type { CommandMenuItem, CommandMenuSection } from '../../command-menu-context.ts';
import { CommandMenuGroup } from '../../CommandMenuRow.tsx';
import { navigationEntriesFor } from './navigation-entries.ts';

/**
 * A tab has less room than a heading, and the whole strip has to fit on one
 * line, so the two longest groups get a shorter name above the list than they
 * carry inside it.
 */
const TAB_LABELS: Readonly<Record<string, string>> = { group_dm: 'Groups', dm: 'DMs' };

/** One tab per sidebar group, in sidebar order. */
export const NAVIGATION_SECTIONS: readonly CommandMenuSection[] = NAVIGATION_GROUPS.map(
  group => ({ id: group.id, label: TAB_LABELS[group.id] ?? group.label }),
);

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
      {groups.map(group => (
        <CommandMenuGroup key={group.id} section={group.id} heading={group.label} items={group.items} />
      ))}
    </>
  );
}
