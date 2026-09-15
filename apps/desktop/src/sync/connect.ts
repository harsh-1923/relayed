// The connect flow (docs/WORKSPACE-AGENTS.md §6.5): listen on a loopback
// port, ask the server to start a connection, open the result in the SYSTEM
// browser, wait for the redirect, then tell the server it's done.
//
// Never a BrowserWindow (PHASE-1-IDENTITY.md, the desktop auth flow §6) — the
// same reasoning sign-in already holds: a window this app draws could be made
// to look like anything, where the system browser is the one surface a
// person's own judgement about the address bar still applies to.
//
// The same shape as `session.ts`'s `signIn()`, as a standalone function
// instead of a class: unlike a session, one connect attempt has no state
// worth holding after it settles.
import { randomBytes } from 'node:crypto';
import { listenForCallback } from './auth/loopback.ts';
import { startConnection, completeConnection } from './auth/relayed.ts';

export type ConnectResult =
  | { ok: true; connectionId: string; status: string }
  | { ok: false; reason: string };

const randomState = (): string =>
  randomBytes(16).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

/**
 * Connect one toolkit. Resolves once the account is ACTIVE, or the attempt is
 * refused, times out, or the browser never finishes.
 *
 * `accessRequestId` is set when this connect was reached from a card (§7.4) —
 * carried through so `connection_attempts` (and, once `access.ts` reads it,
 * the card itself) can tell "a plain visit" from "resolving this run's
 * block" apart. Optional: the connector store's own Connect button has none.
 */
export async function connect(
  openBrowser: (url: string) => Promise<void>,
  accessToken: string, toolkit: string, accessRequestId?: string,
): Promise<ConnectResult> {
  const state = randomState();
  const listener = await listenForCallback<'session_uri'>({
    path: '/connected',
    paramNames: ['session_uri'],
    state,
    successPage: { title: 'Connected', body: 'You can close this tab and return to Relayed.' },
  });
  const port = Number(new URL(listener.redirectUri).port);

  try {
    const started = await startConnection(accessToken,
      { toolkit, port, state, ...(accessRequestId ? { accessRequestId } : {}) });
    if (!started.ok) return { ok: false, reason: started.error };

    // AFTER the browser opens, not before — the same ordering sign-in holds,
    // for the same reason: a listener that is not actually live yet must
    // never be advertised as ready.
    await openBrowser(started.start_url);
    const { session_uri: sessionUri } = await listener.result;

    const completed = await completeConnection(accessToken, started.connection_id, sessionUri);
    if (!completed.ok) return { ok: false, reason: completed.error };
    return { ok: true, connectionId: completed.connection_id, status: completed.status };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'connect failed' };
  } finally {
    listener.close();
  }
}
