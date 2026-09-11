import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '@/app/state';
import { call } from '@/lib/ipc';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';

export function SignIn() {
  const { state, apply } = useSession();
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // Sign-in finishes in the browser, so the thing that ends this route is a
  // push, not a click. Bounce through "/" rather than guessing a destination —
  // an invited person and a first-time owner end up in different places.
  const inFlight = state.auth.status === 'authenticating'
    || state.auth.status === 'awaiting_browser';
  const done = state.auth.status !== 'signed_out' && !inFlight;
  useEffect(() => { if (done) navigate('/', { replace: true }); }, [done, navigate]);

  // Deliberately NOT awaited into a local `busy` flag. auth.signIn does not
  // resolve until the browser comes back — up to five minutes — and a local
  // flag is lost the moment the window reloads, which left an earlier version
  // showing a dead "Waiting for the browser…" with no way out.
  // `awaitingBrowser` is pushed from the process that actually knows.
  const signIn = useCallback(() => {
    setError(null);
    void call(api => api.query('auth.signIn'))
      .then(apply)
      .catch((e: Error) => setError(e.message));
  }, [apply]);

  // Both are invoked with `void`, so an unguarded rejection here is unhandled
  // rather than caught downstream — the trap invariant 54 is about.
  const cancel = useCallback(async () => {
    setError(null);
    try { apply(await call(api => api.query('auth.cancelSignIn'))); }
    catch (e) { setError((e as Error).message); }
  }, [apply]);

  const reopen = useCallback(async () => {
    setError(null);
    try { await call(api => api.query('auth.reopenBrowser')); }
    catch (e) { setError((e as Error).message); }
  }, []);

  return (
    <main className="grid min-h-0 flex-1 place-items-center overflow-y-auto bg-background p-10 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Relayed</CardTitle>
          <CardDescription>
            WorkOS AuthKit → our session · system browser · PKCE · loopback
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Sign-in is the one thing here that genuinely needs the network, so
              simulated offline makes it fail with an opaque "fetch failed".
              Saying which switch caused it is the difference between a puzzle
              and a one-click fix. */}
          {state.offline && (
            <Alert>
              <AlertTitle>Simulated offline is on</AlertTitle>
              <AlertDescription>
                Signing in needs the network and will fail until you turn it off
                — the control is at the bottom right.
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertTitle>Something went wrong</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {state.auth.status === 'awaiting_browser' ? (
            // Three ways out, because three things go wrong: the browser opened
            // and was dismissed, the browser never appeared, or the person
            // changed their mind. All three used to lead to a disabled button
            // and a five-minute wait.
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Waiting for your browser. Finish signing in there, and this window
                will catch up on its own.
              </p>
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={() => void reopen()}>
                  Open the link again
                </Button>
                <Button variant="ghost" onClick={() => void cancel()}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button onClick={signIn}>Sign in</Button>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
