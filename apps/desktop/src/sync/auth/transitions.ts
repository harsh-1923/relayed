// The edges of the auth lifecycle, declared.
//
// `session.ts` had this machine written down half-way: every `#set()` names a
// DESTINATION and none of them names a legal SOURCE. Six statuses admit
// thirty-six ordered pairs; these are the sixteen that mean something, and
// before this file nobody had said which.
//
// The artifact is the point. The check is a side effect — writing the table
// forced questions nobody had answered, and two of the answers were surprises
// (see `signed_out` below).
//
// NOT a substitute for a deadline. A table rejects an ILLEGAL transition and
// says nothing about an ABSENT one: the sign-in hang sat in a state with three
// perfectly legal exits, none of which anything fired. That is invariant 64's
// job, and the loopback's five-minute timeout does it.
import { count } from '@relayed/telemetry';
import type { AuthState } from './session.ts';

export type Status = AuthState['status'];

/**
 * `satisfies` rather than a plain annotation, so adding a sixth status does not
 * compile until its edges are declared. The table cannot rot behind the union.
 */
export const ALLOWED = {
  // Boot lands here and can go anywhere a stored credential allows. The two
  // non-obvious edges are the ones a guess would have missed: a boot with a
  // vault slot refreshes straight to `authenticated`, and a boot with a slot
  // the server rejects goes straight to `stale` — neither passes through
  // `authenticating`, because neither involves a browser.
  signed_out:       ['authenticating', 'authenticated', 'stale'],

  // Binding the loopback socket. Sub-millisecond, and there is nothing to
  // cancel yet — the only exits are the browser opening, or failing to.
  authenticating:   ['awaiting_browser', 'signed_out'],

  // The browser is open and the person is in it. Stays entered through the
  // token exchange, which is why a code arriving does not make the UI flash
  // back to a "Sign in" button.
  awaiting_browser: ['needs_workspace', 'authenticated', 'signed_out'],

  // `stale` is reachable here because `activate` runs at boot regardless of
  // whether onboarding has finished.
  needs_workspace:  ['authenticated', 'signed_out', 'stale'],

  // Deliberately NOT to `authenticating`. Signing in while signed in has no
  // meaning today; if account switching arrives it is a different flow with a
  // different entry point, and it should have to add this edge on purpose.
  authenticated:    ['stale', 'signed_out'],

  // To `authenticating` IS allowed: re-authenticating from a stale session is
  // the natural recovery, and the affordance for it — a "Reconnect" action on
  // the stale banner — is not built yet. The edge is declared ahead of the
  // button rather than discovered by it.
  stale:            ['authenticated', 'signed_out', 'authenticating'],
} as const satisfies Record<Status, readonly Status[]>;

/**
 * Loud where a person can act on it, counted where they cannot.
 *
 * A crash is the right answer in development, where an illegal transition is a
 * bug being written. It is the wrong answer in a user's app, where the state is
 * merely unexpected and the read path still works — this codebase's whole
 * posture is that an auth surprise must never close the read path.
 */
export function assertEdge(from: Status, to: Status): void {
  if (from === to) return;
  if ((ALLOWED[from] as readonly Status[]).includes(to)) return;
  count('auth.illegal_transition');
  if (process.env['NODE_ENV'] !== 'production') {
    throw new Error(`illegal auth transition: ${from} → ${to}`);
  }
}
