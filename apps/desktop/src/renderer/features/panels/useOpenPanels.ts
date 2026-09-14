// Which panels are open as tabs, and which tab is shown: `?p=` and `?pa=`, and
// nothing else (PANELS.md §8). View state, so it is never stored — two people in
// one room can have entirely different tabs open, and a link with the query
// stripped still opens the space.
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { activePanelId, closePanelTab, formatPanelParam, parsePanelParam } from '../../../shared/panels.ts';

export interface OpenPanels {
  /** The container may be open with no tabs, which is represented by an empty `?p=`. */
  containerOpen: boolean;
  /** The open tabs, in the order they were opened. */
  ids: string[];
  /** The tab shown. One panel at a time; null when no tab is open. */
  active: string | null;
  /** Open a panel as a tab, or bring its tab forward. A history entry, so Back undoes it. */
  open: (id: string) => void;
  /** Show the empty container without inventing a panel. */
  openContainer: () => void;
  /** Close the whole container and all of its tabs. */
  closeContainer: () => void;
  /** Show another open tab. Not a history entry: switching tabs is not navigating. */
  select: (id: string) => void;
  close: (id: string) => void;
  /** Rewrite the tabs without a history entry: for canonicalising, not for the person's own actions. */
  replace: (ids: readonly string[], active: string | null) => void;
}

export function useOpenPanels(): OpenPanels {
  const [params, setParams] = useSearchParams();
  const rawIds = params.get('p');
  const rawActive = params.get('pa');
  const containerOpen = params.has('p');
  const ids = useMemo(() => parsePanelParam(rawIds), [rawIds]);
  const active = activePanelId(ids, rawActive);

  const write = useCallback((next: readonly string[], shown: string | null, replace: boolean, keepEmpty = false) => {
    setParams(previous => {
      const params = new URLSearchParams(previous);
      if (next.length > 0 || keepEmpty) params.set('p', formatPanelParam(next));
      else params.delete('p');
      // Left out when it would say what the default already does: the last tab.
      if (shown && shown !== next.at(-1)) params.set('pa', shown);
      else params.delete('pa');
      return params;
    }, { replace });
  }, [setParams]);

  return useMemo(() => ({
    containerOpen,
    ids,
    active,
    open: id => write(ids.includes(id) ? ids : [...ids, id], id, false),
    openContainer: () => write([], null, false, true),
    closeContainer: () => write([], null, false),
    select: id => { if (ids.includes(id)) write(ids, id, true); },
    close: id => {
      const next = closePanelTab(ids, active, id);
      write(next.ids, next.active, false);
    },
    replace: (next, shown) => write(next, shown, true, containerOpen),
  }), [containerOpen, ids, active, write]);
}
