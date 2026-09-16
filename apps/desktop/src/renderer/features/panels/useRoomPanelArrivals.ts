// A synced room's shared panels reaching the screen (PANELS.md): the page an
// agent opened for the room appears beside the chat for everyone there, and
// someone arriving sees what the room is working beside. The decision is
// `panelArrivals`; this only feeds it and applies the answer to `?p=`.
import { useEffect, useRef } from 'react';
import type { Panel } from '../../../preload/api';
import { panelArrivals, seenPanels, type SeenPanels } from '../../../shared/panels.ts';
import type { OpenPanels } from './useOpenPanels';

/**
 * What each person closed, per room, for as long as the app runs. Never stored
 * and never synced: closing a tab is this person's view, not the room's.
 */
const dismissedByRoom = new Map<string, Set<string>>();

/** The shared panels each room was last seen with, so a page opened while this person was elsewhere still arrives. */
const seenByRoom = new Map<string, SeenPanels>();

/** Stands in for the new-panel tab when asking `panelArrivals`; never a real panel id. */
const NEW_TAB = '\u0000new-panel';

export function useRoomPanelArrivals(input: {
  enabled: boolean; ready: boolean; spaceId: string; panels: readonly Panel[]; openPanels: OpenPanels;
}): void {
  const { enabled, ready, spaceId, panels, openPanels } = input;
  const lastOpen = useRef<{ spaceId: string; ids: readonly string[] } | null>(null);

  // A tab that was open and is not any more was closed by this person.
  useEffect(() => {
    const previous = lastOpen.current;
    if (previous?.spaceId === spaceId) {
      const dismissed = dismissedByRoom.get(spaceId) ?? new Set<string>();
      for (const id of previous.ids) if (!openPanels.ids.includes(id)) dismissed.add(id);
      for (const id of openPanels.ids) dismissed.delete(id);
      dismissedByRoom.set(spaceId, dismissed);
    }
    lastOpen.current = { spaceId, ids: openPanels.ids };
  }, [spaceId, openPanels.ids]);

  useEffect(() => {
    if (!enabled || !ready) return;
    const known = seenByRoom.get(spaceId) ?? null;
    // Someone on the new-panel tab is choosing what to open, which is looking
    // at something: an arriving page joins the tabs and waits.
    const choosing = openPanels.newTabOpen;
    const next = panelArrivals({
      seen: known,
      panels,
      open: {
        containerOpen: openPanels.containerOpen,
        ids: choosing ? [...openPanels.ids, NEW_TAB] : openPanels.ids,
        active: choosing ? NEW_TAB : openPanels.active,
      },
      dismissed: dismissedByRoom.get(spaceId) ?? new Set(),
    });
    seenByRoom.set(spaceId, seenPanels(panels));
    // Replaced, not pushed: a page arriving is not the person navigating, so
    // Back must not walk through what the room opened.
    if (next) {
      const active = next.active === NEW_TAB ? openPanels.active : next.active;
      openPanels.replace(next.ids.filter(id => id !== NEW_TAB), active);
    }
    // `openPanels` is read, not depended on: the tabs changing must not count
    // as panels arriving.
  }, [enabled, ready, spaceId, panels]); // eslint-disable-line react-hooks/exhaustive-deps
}
