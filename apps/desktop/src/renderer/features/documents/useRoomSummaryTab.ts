// A room's summary is always a tab (docs/DOCUMENTS.md §8.1).
//
// Not a panel somebody opened: the room owns it, it is created with the room,
// and it cannot be closed. So it is not in `?p=` — it is put at the front of
// the tabs on every render, which is also why leaving a room and coming back
// cannot lose it.
//
// The CONTAINER is a different question, and it is this person's: the summary
// is shown the first time they enter a room in this session. After that the
// room is as they left it (`useOpenPanels`), closed included. "Nobody has to
// know to open it" and "it reopens every time I close it" are both rules; only
// the first one is wanted.
import { useEffect } from 'react';
import type { Panel } from '../../../preload/api';
import type { OpenPanels } from '../panels/useOpenPanels';

/** The room's structural summary panel, first, then whatever this person opened. */
export function withSummaryFirst(tabs: readonly Panel[], panels: readonly Panel[]): Panel[] {
  const summary = panels.find(panel => panel.type === 'doc');
  if (!summary) return [...tabs];
  return [summary, ...tabs.filter(panel => panel.id !== summary.id)];
}

export function useRoomSummaryTab(input: {
  enabled: boolean; ready: boolean; spaceId: string; panels: readonly Panel[]; openPanels: OpenPanels;
}): void {
  const { enabled, ready, spaceId, panels, openPanels } = input;

  useEffect(() => {
    if (!enabled || !ready || openPanels.containerOpen || openPanels.remembered) return;
    if (!panels.some(panel => panel.type === 'doc')) return;
    // No ids: the summary is not in `?p=` at all, so an open container with
    // nothing else opened shows exactly it.
    openPanels.openContainer();
    // `openPanels` is read, not depended on: opening the container must not
    // re-run this and fight somebody closing it.
  }, [enabled, ready, spaceId, panels]); // eslint-disable-line react-hooks/exhaustive-deps
}
