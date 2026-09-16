// Which panels are open as tabs, and which tab is shown: `?p=`, `?pa=` and
// `?pn` (PANELS.md §8). View state, so it is never stored — two people in one
// room can have entirely different tabs open, and a link with the query
// stripped still opens the space.
//
// The URL only holds the room on screen, so each room's tabs are also kept
// here for as long as the app runs (§8.1): closing the container hides them
// rather than forgetting them, and a room entered again is as it was left.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { activePanelId, closePanelTab, formatPanelParam, parsePanelParam } from '../../../shared/panels.ts';

export interface OpenPanels {
  /** The container may be open with no tabs, which is represented by an empty `?p=`. */
  containerOpen: boolean;
  /** The tabs, in the order they were opened — while the container is closed, the ones it will reopen with. */
  ids: string[];
  /** The tab shown, or shown last while the container is closed. One panel at a time; null when there is none. */
  active: string | null;
  /** This person has had the container open in this room since the app started. */
  remembered: boolean;
  /**
   * The new-panel tab — a browser's new tab — is open, and shown. `?pn`, present
   * or absent. It offers what to open next, and becomes the panel chosen.
   */
  newTabOpen: boolean;
  /** Open a panel as a tab, or bring its tab forward. A history entry, so Back undoes it. */
  open: (id: string) => void;
  /** Add a tab without showing it, as Cmd+click does in a browser. Opens the container if it was closed. */
  add: (id: string) => void;
  /** Show the container with the tabs it had, or empty when it has had none. */
  openContainer: () => void;
  /** Hide the container. Its tabs are kept for when it opens again. */
  closeContainer: () => void;
  /** Show another open tab. Not a history entry: switching tabs is not navigating. */
  select: (id: string) => void;
  close: (id: string) => void;
  /** Open the new-panel tab beside the others, and show it. */
  openNewTab: () => void;
  /** Close the new-panel tab without choosing anything. */
  closeNewTab: () => void;
  /** Rewrite the tabs without a history entry: for canonicalising, not for the person's own actions. */
  replace: (ids: readonly string[], active: string | null) => void;
}

interface RoomView { open: boolean; ids: string[]; active: string | null }

/** Each room's tabs as this person last had them. Never stored, never synced. */
const viewByRoom = new Map<string, RoomView>();

export function useOpenPanels(): OpenPanels {
  const { spaceId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const rawIds = params.get('p');
  const rawActive = params.get('pa');
  const newTabOpen = params.has('pn');
  const containerOpen = params.has('p') || newTabOpen;
  const urlIds = useMemo(() => parsePanelParam(rawIds), [rawIds]);
  const view = containerOpen ? null : viewByRoom.get(spaceId);
  const ids = view ? view.ids : urlIds;
  const active = view ? view.active : activePanelId(urlIds, rawActive);

  /**
   * `newTab`: true opens the new-panel tab, false closes it, `keep` leaves it —
   * a panel arriving for the room must not close the tab someone is choosing in.
   */
  const write = useCallback((
    next: readonly string[], shown: string | null, replace: boolean, keepEmpty: boolean, newTab: boolean | 'keep',
  ) => {
    setParams(previous => {
      const params = new URLSearchParams(previous);
      const newTabAfter = newTab === 'keep' ? previous.has('pn') : newTab;
      if (next.length > 0 || keepEmpty || newTabAfter) params.set('p', formatPanelParam(next));
      else params.delete('p');
      // Left out when it would say what the default already does: the last tab.
      if (shown && shown !== next.at(-1)) params.set('pa', shown);
      else params.delete('pa');
      if (newTabAfter) params.set('pn', '');
      else params.delete('pn');
      return params;
    }, { replace });
  }, [setParams]);

  const entered = useRef<string | null>(null);
  useEffect(() => {
    if (entered.current !== spaceId) {
      entered.current = spaceId;
      // Entering a room: a URL that names its panels wins (Back, a link);
      // otherwise the room is shown as this person left it.
      if (view?.open) {
        write(view.ids, view.active, true, true, false);
        return;
      }
    }
    if (containerOpen) viewByRoom.set(spaceId, { open: true, ids, active });
    else if (view) viewByRoom.set(spaceId, { ...view, open: false });
  }, [spaceId, containerOpen, ids, active]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => ({
    containerOpen,
    ids,
    active,
    get remembered() { return viewByRoom.has(spaceId); },
    newTabOpen,
    open: id => write(ids.includes(id) ? ids : [...ids, id], id, false, false, false),
    add: id => write(ids.includes(id) ? ids : [...ids, id], active ?? ids.at(-1) ?? id, false, true, 'keep'),
    openContainer: () => write(ids, active, false, true, false),
    closeContainer: () => write([], null, false, false, false),
    select: id => { if (ids.includes(id)) write(ids, id, true, true, false); },
    close: id => {
      const next = closePanelTab(ids, active, id);
      write(next.ids, next.active, false, newTabOpen, 'keep');
    },
    openNewTab: () => write(ids, active, false, true, true),
    closeNewTab: () => write(ids, active, false, ids.length > 0, false),
    replace: (next, shown) => write(next, shown, true, containerOpen, 'keep'),
  }), [spaceId, containerOpen, ids, active, newTabOpen, write]);
}
