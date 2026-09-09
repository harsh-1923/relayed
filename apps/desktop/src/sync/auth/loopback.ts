// Loopback OAuth callback receiver (RFC 8252 §7.3).
//
// Custom schemes (`relayed://`) DO NOT WORK in unpackaged development on macOS:
// `setAsDefaultProtocolClient` records a Launch Services handler preference that
// binds to nothing, because no unpackaged bundle declares the scheme in
// CFBundleURLTypes — and `isDefaultProtocolClient` then reports `true` anyway.
// Verified; see PHASE-1-IDENTITY.md §6.
//
// Loopback works identically in dev and production, so it is the primary path
// rather than a dev-only fallback — a divergence between dev and production auth
// is exactly where bugs hide. WorkOS permits `http://127.0.0.1:*/…` for native
// clients, and 127.0.0.1 is the one HTTP redirect allowed in production.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const CALLBACK_PATH = '/auth/callback';

export interface CallbackResult { code: string; state: string }

export interface Listener {
  /** Redirect URI to hand the authorization server. */
  redirectUri: string;
  /** Resolves once a matching callback arrives; rejects on timeout or error. */
  result: Promise<CallbackResult>;
  close(): void;
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px/1.6 system-ui;display:grid;place-items:center;height:90vh;margin:0">` +
  `<div style="text-align:center"><h1 style="font-size:17px;margin:0 0 6px">${title}</h1>` +
  `<p style="color:#666;margin:0">${body}</p></div>`;

/**
 * Binds an ephemeral port on 127.0.0.1 and waits for exactly one callback.
 * Bound to the loopback interface only, single-use, and torn down as soon as it
 * resolves — it exists for the seconds between opening the browser and the
 * redirect landing.
 */
export function listenForCallback(opts: { state: string; timeoutMs?: number }): Promise<Listener> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  return new Promise((resolveListener, rejectListener) => {
    let settle: (r: CallbackResult) => void;
    let fail: (e: Error) => void;
    const result = new Promise<CallbackResult>((res, rej) => { settle = res; fail = rej; });
    // A callback can arrive (or time out) before the caller awaits `result`.
    // Without a handler attached here that becomes an unhandled rejection,
    // which in Node terminates the process — so a forged state would crash the
    // sync engine instead of failing the sign-in. The caller's await still
    // observes the rejection normally.
    result.catch(() => {});

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end(); return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      // Verified BEFORE the code is used: a mismatched state means this
      // redirect does not belong to the request we started.
      if (!error && state !== opts.state) {
        res.writeHead(400, { 'content-type': 'text/html' })
           .end(page('Sign-in failed', 'State mismatch — this response did not match the request.'));
        fail(new Error('state mismatch'));
        close();
        return;
      }

      if (error || !code) {
        res.writeHead(400, { 'content-type': 'text/html' })
           .end(page('Sign-in failed', error ?? 'No authorization code was returned.'));
        fail(new Error(error ?? 'no code in callback'));
        close();
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html' })
         .end(page('Signed in', 'You can close this window and return to Relayed.'));
      settle({ code, state: state ?? '' });
      close();
    });

    const timer = setTimeout(() => { fail(new Error('callback timed out')); close(); }, timeoutMs);
    timer.unref?.();

    /**
     * Tear down, and SETTLE anyone waiting.
     *
     * The rejection is the part that matters. `close()` used to stop the server
     * and leave `result` pending forever, so a caller awaiting it waited for
     * ever — which is exactly what stranded the app when a sign-in was
     * abandoned: the listener was gone, the await never returned, and the UI
     * sat on "waiting for the browser" until the five-minute timeout that
     * close() had just cancelled.
     *
     * `fail` after `settle` is a no-op, so the success path is unaffected: the
     * first settlement wins, as always with promises.
     */
    function close(): void {
      clearTimeout(timer);
      fail(new Error('sign-in listener closed'));
      server.close();
      server.closeAllConnections?.();
    }

    server.once('error', rejectListener);
    // 127.0.0.1 explicitly, never 0.0.0.0 — this must not be reachable off-box.
    // Port 0 lets the OS pick, which is why the redirect URI needs a wildcard
    // port registered with the authorization server.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolveListener({
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        result,
        close,
      });
    });
  });
}
