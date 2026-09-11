// Where you are in the back/forward stack, and whether either direction leads
// anywhere.
//
// THE PROBLEM. React Router can MOVE through history — `navigate(-1)`,
// `navigate(1)` — but it cannot say whether there is anywhere to move to, and
// neither can the DOM: `history.length` counts the whole session including
// entries ahead of the cursor, and it never shrinks. So a button wired straight
// to `navigate(-1)` is lit on the first screen after sign-in and does nothing
// when pressed. A control that is always enabled and sometimes inert is worse
// than no control, because you cannot tell the two cases apart by looking.
//
// So position is TRACKED, from two facts React Router already maintains:
//
//   - `history.state.idx`, which both the browser and the hash history write on
//     every entry. That is WHERE the cursor is.
//   - `useNavigationType()`, which says HOW we arrived. Only `PUSH` matters:
//     pushing truncates everything ahead of the cursor, so the top of the stack
//     becomes the entry we just landed on.
//
// EVERY NAVIGATION COUNTS, not every path. Keyed on the location object, which
// React Router replaces per entry — so `/w/A/c/1` → `/w/A/c/2` registers, even
// though the pathname pattern, the route and the rendered component are all
// identical. A comparison on `pathname` would miss a parameter change; one on
// the matched route would miss it too, and both of those are journeys Back has
// to be able to undo. Search and hash changes are entries by the same rule.
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router';

/**
 * The cursor's index, if the history says.
 *
 * Absent on the very first entry of a fresh window, before React Router has
 * written its state — hence the fallback at the call site rather than a zero
 * here, which would silently claim "you are at the start" every time the read
 * failed.
 */
const cursorOf = (): number | null => {
  // Reached through `globalThis` rather than `window` so this module stays
  // compilable without the DOM library. Its test runs under `node --test`,
  // which tsconfig.node.json type-checks with no DOM types at all — a bare
  // `window` here fails the build for a file the test only imports.
  const history = (globalThis as { history?: { state?: { idx?: unknown } } }).history;
  const idx = history?.state?.idx;
  return typeof idx === 'number' ? idx : null;
};

/** Where the cursor is, and how tall the stack it sits in is. */
export interface Stack {
  /** The cursor's index. */
  at: number;
  /** The highest index that still exists ahead of, or at, the cursor. */
  top: number;
}

/**
 * The whole of the logic, as a function of what happened.
 *
 * Pulled out of the hook so it can be tested at all: the renderer's tests are
 * plain `node --test` with no DOM, and a rule this easy to get subtly wrong —
 * one `max` in the wrong branch and Forward stays lit forever — should not be
 * reachable only by clicking.
 *
 * `cursor` is null when the history has not written its index yet, which is the
 * first entry of a fresh window.
 *
 * TAKES `pushed`, NOT A NAVIGATION TYPE. Pushing is the only distinction the
 * rule turns on — a pop in either direction and a replace are all "the stack
 * did not get shorter" — and a boolean keeps react-router's `NavigationType`
 * (a string enum, so not interchangeable with its own string values) out of a
 * function whose whole purpose is to be callable from a test.
 */
export function advance(
  prev: Stack, { cursor, pushed }: { cursor: number | null; pushed: boolean },
): Stack {
  const at = cursor ?? (pushed ? prev.at + 1 : prev.at);
  // A push DISCARDS the entries ahead of the cursor, so the top comes down to
  // meet it. Anything else — a pop in either direction, a replace — leaves the
  // stack's height alone, and `max` is what stops a walk backwards from
  // forgetting that forward exists.
  const top = pushed ? at : Math.max(prev.top, at);
  // Returning `prev` unchanged keeps this idempotent, which matters: in
  // StrictMode the effect calls it twice for one navigation.
  return at === prev.at && top === prev.top ? prev : { at, top };
}

export interface BackForward {
  /** There is an entry behind the cursor. */
  canBack: boolean;
  /** There is an entry ahead of it — only ever true after going back. */
  canForward: boolean;
  back: () => void;
  forward: () => void;
}

export function useBackForward(): BackForward {
  const location = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();

  const [{ at, top }, setCursor] = useState(() => {
    const start = cursorOf() ?? 0;
    return { at: start, top: start };
  });

  useEffect(() => {
    setCursor(prev => advance(prev, { cursor: cursorOf(), pushed: type === 'PUSH' }));
  }, [location, type]);

  return {
    canBack: at > 0,
    canForward: at < top,
    back: useCallback(() => { navigate(-1); }, [navigate]),
    forward: useCallback(() => { navigate(1); }, [navigate]),
  };
}
