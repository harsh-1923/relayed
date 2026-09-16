// Opening a passage someone clicked (docs/ANNOTATIONS.md).
//
// The click happens inside a message, and the room is what can open a panel —
// it holds the panel list and the open tabs, and the message knows about
// neither. So the message asks, and the room answers.
//
// Opening is not enough on its own. The store returns the SAME panel when the
// same address is opened twice, so clicking a passage whose page is already a
// tab used to change nothing at all — which reads as the click being broken
// rather than as already being there. So an open panel is also POINTED at the
// address, which scrolls back to the passage and paints it again
// (`spikes/text-fragments` measures both, and that the document survives).
import { useEffect, useState } from 'react';

type Registry<T> = Map<string, Set<(value: T) => void>>;

const rooms: Registry<string> = new Map();
const panels: Registry<string> = new Map();

/** A link in a room's web page that wants a tab; `background` for Cmd+click. */
export interface LinkRequest { address: string; background: boolean }
const links: Registry<LinkRequest> = new Map();

/** Ask the room to open this passage. */
export function showAnnotation(spaceId: string, address: string): void {
  for (const listener of rooms.get(spaceId) ?? []) listener(address);
}

/**
 * Send a panel that is already open back to a passage.
 *
 * Only the fragment changes, so the document survives: the page keeps its
 * scroll elsewhere, its forms and anything playing, and simply moves.
 */
export function pointPanel(panelId: string, address: string): void {
  for (const listener of panels.get(panelId) ?? []) listener(address);
}

/** Ask the room to open a link from one of its pages as a tab. */
export function openLink(spaceId: string, request: LinkRequest): void {
  for (const listener of links.get(spaceId) ?? []) listener(request);
}

/** The room answers links that want a tab for as long as it is on screen. */
export function useLinkRequests(spaceId: string, onOpen: (request: LinkRequest) => void): void {
  useSubscription(links, spaceId, onOpen);
}

/** The room answers annotation clicks for as long as it is on screen. */
export function useAnnotationRequests(spaceId: string, onShow: (address: string) => void): void {
  useSubscription(rooms, spaceId, onShow);
}

/** A panel answers for its own id. */
export function usePanelPointer(panelId: string, onPoint: (address: string) => void): void {
  useSubscription(panels, panelId, onPoint);
}

/**
 * Subscribe without tearing the subscription down on every render: the handlers
 * close over state that changes constantly, and depending on the handler itself
 * would drop a request that arrived between the two.
 */
function useSubscription<T>(registry: Registry<T>, key: string, handler: (value: T) => void): void {
  const [held] = useState(() => ({ current: handler }));
  held.current = handler;

  useEffect(() => {
    if (key === '') return;
    const listener = (value: T): void => { held.current(value); };
    const forKey = registry.get(key) ?? new Set<(value: T) => void>();
    forKey.add(listener);
    registry.set(key, forKey);
    return () => {
      forKey.delete(listener);
      if (forKey.size === 0) registry.delete(key);
    };
  }, [registry, key, held]);
}
