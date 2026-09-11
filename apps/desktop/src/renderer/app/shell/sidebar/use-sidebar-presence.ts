// Is there a sidebar on screen right now?
//
// The toggle lives in the top bar and the sidebar lives in the shell, and the
// top bar is the shell's SIBLING — above it, so that it survives the routes the
// shell does not cover. Context flows down, so the shell cannot tell the bar
// anything, and the bar cannot ask.
//
// The alternative was for the bar to re-derive the answer: "a sidebar exists
// when a workspace is open AND the route is one the shell wraps". That is the
// route table restated in a second place, and a toggle for a panel that is not
// there — or a missing toggle for one that is — is a small wrong thing that
// only shows up on /account.
//
// So the sidebar SAYS it is there, through the smallest store that works. A
// count rather than a boolean because React unmounts the next tree after
// mounting the previous one during a transition, and under StrictMode mounts
// and unmounts twice; both are balanced, a boolean would not be.
import { useEffect, useSyncExternalStore } from 'react';

let mounted = 0;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Called by the sidebar, for as long as it is on screen. */
export function useAnnounceSidebar(): void {
  useEffect(() => {
    mounted += 1;
    for (const listener of listeners) listener();
    return () => {
      mounted -= 1;
      for (const listener of listeners) listener();
    };
  }, []);
}

/** Called by anything that needs to know — the top bar's toggle. */
export function useSidebarPresent(): boolean {
  return useSyncExternalStore(subscribe, () => mounted > 0, () => false);
}
