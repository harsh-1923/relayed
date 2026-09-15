// Bringing a refused connection back without anyone doing anything.
//
// The transport parks in `unauthorised` when the server refuses its token, and
// waits for `retryNow` rather than retrying the same token in a loop — right,
// as far as it goes. But the only callers of `retryNow` were waking from sleep,
// the dev offline toggle and switching workspace. A server restart after the
// access token had quietly expired (it lives 15 minutes, and a live socket is
// never closed for it) left the client refused on reconnect and parked for
// good: nothing sent, nothing received, and a message sitting in the outbox
// with zero attempts.
//
// So: while parked, refresh with backoff, and reconnect once there is a token
// the server has not already refused. A token that is still valid and was
// refused anyway is not something waiting will fix, so that stops here.
import { backoffDelay, type LinkState } from './transport/connection.ts';

export interface ReauthDeps {
  /** A usable access token, refreshing it first if it has expired — `Session.ensureFresh`. */
  refresh(): Promise<string | null>;
  /** The token held right now, without refreshing — what the server just refused. */
  held(): string | null;
  /** Nobody is signed in: there is nothing to refresh, so nothing to retry. */
  signedOut(): boolean;
  /** Reconnect now — `Link.retryNow`. */
  retryNow(): void;
  /** Seams for tests. */
  random?(): number;
  schedule?(fn: () => void, ms: number): unknown;
  cancel?(handle: unknown): void;
}

export interface Reauth {
  /** Every link state change goes through here. */
  onState(state: LinkState): void;
  stop(): void;
}

export function createReauth(deps: ReauthDeps): Reauth {
  // Unref'd: a pending attempt must never be what keeps the sync process alive at quit.
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref());
  const cancel = deps.cancel ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  let state: LinkState = 'idle';
  let timer: unknown = null;
  let attempt = 0;

  const attemptLater = (): void => {
    if (timer !== null || deps.signedOut()) return;
    const refused = deps.held();
    timer = schedule(() => {
      timer = null;
      void (async () => {
        if (state !== 'unauthorised' || deps.signedOut()) return;
        const token = await deps.refresh();
        // Something else revived it while the refresh ran.
        if (state !== 'unauthorised') return;
        if (token !== null && token !== refused) { deps.retryNow(); return; }
        // Refused while still valid: a better token will not come from waiting.
        if (token !== null) return;
        // No token yet — the server is still coming up, or the network is out.
        attempt++;
        attemptLater();
      })();
    }, backoffDelay(attempt, deps.random ?? Math.random));
  };

  return {
    onState(next) {
      state = next;
      if (next === 'unauthorised') attemptLater();
      else if (next === 'live') attempt = 0;
    },
    stop() {
      if (timer !== null) cancel(timer);
      timer = null;
    },
  };
}
