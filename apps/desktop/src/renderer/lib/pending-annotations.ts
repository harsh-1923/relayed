// A passage marked but not yet written into the composer (docs/ANNOTATIONS.md).
//
// A marked passage has to cross the room: it is captured in a web panel on the
// right and lands in the composer on the left, which share only the route above
// them. This is that crossing, and nothing more.
//
// It carries a LINK, not a part: the label a reader sees and the address that
// goes back to the passage. Once the composer has written it, this holds
// nothing — the annotation is text in the draft like any other text, so it
// survives a restart with the draft and needs nothing kept here.
import { useEffect, useState } from 'react';

export interface MarkedPassage {
  /** The quote, short enough to read inside a sentence. */
  label: string;
  /** The page with its text directive: where clicking goes. */
  address: string;
}

const listeners = new Map<string, Set<(passage: MarkedPassage) => void>>();

/** Mark a passage: tell the composer to write its link. */
export function markAnnotation(spaceId: string, passage: MarkedPassage): void {
  for (const listener of listeners.get(spaceId) ?? []) listener(passage);
}

/** Run `onMarked` each time a passage is marked in this room, while the composer is open. */
export function useMarkedAnnotations(
  spaceId: string, onMarked: (passage: MarkedPassage) => void,
): void {
  // The handler closes over editor state that changes on every keystroke;
  // holding it in a stable box and reading it from one subscriber keeps the
  // subscription from being torn down and rebuilt as the person types.
  const [held] = useState(() => ({ current: onMarked }));
  held.current = onMarked;

  useEffect(() => {
    if (spaceId === '') return;
    const listener = (passage: MarkedPassage): void => { held.current(passage); };
    const forSpace = listeners.get(spaceId) ?? new Set<(passage: MarkedPassage) => void>();
    forSpace.add(listener);
    listeners.set(spaceId, forSpace);
    return () => {
      forSpace.delete(listener);
      if (forSpace.size === 0) listeners.delete(spaceId);
    };
  }, [spaceId, held]);
}
