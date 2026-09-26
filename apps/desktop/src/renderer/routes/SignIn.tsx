import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '@/app/state';
import { call } from '@/lib/ipc';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AppIconMark } from '@/components/AppIconMark';

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
  useEffect(() => { if (done) void navigate('/', { replace: true }); }, [done, navigate]);

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

  // Linear's structure, our look: the mark, one line, one button, centred. What
  // the person picks — Google, email — happens on WorkOS's page, so there is
  // only ever one thing to press here.
  return (
    <main className="grid min-h-0 flex-1 place-items-center overflow-y-auto bg-background p-10 text-foreground">
      <div className="flex w-full max-w-sm flex-col items-center gap-8 text-center">
        <AppIconMark className="size-16" />
        <h1 className="text-2xl font-medium">Log in to Relayed</h1>

        <div className="w-full space-y-3">
          {/* Sign-in is the one thing here that genuinely needs the network, so
              simulated offline makes it fail with an opaque "fetch failed".
              Saying which switch caused it is the difference between a puzzle
              and a one-click fix. */}
          {state.offline && (
            <Alert className="text-left">
              <AlertTitle>Simulated offline is on</AlertTitle>
              <AlertDescription>
                Signing in needs the network and will fail until you turn it off
                — the control is at the bottom right.
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive" className="text-left">
              <AlertTitle>Something went wrong</AlertTitle>
              <AlertDescription className="[overflow-wrap:anywhere]">{error}</AlertDescription>
            </Alert>
          )}

          {state.auth.status === 'awaiting_browser' ? (
            <>
              <p className="text-sm text-muted-foreground">
                Finish signing in in your browser — this window will catch up on its own.
              </p>
              <Button size="lg" variant="secondary" className="w-full rounded-full" onClick={() => void reopen()}>
                Open the link again
              </Button>
              <Button size="lg" variant="ghost" className="w-full rounded-full" onClick={() => void cancel()}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="lg" className="w-full rounded-full" onClick={signIn}>Sign in</Button>
          )}
        </div>
      </div>
    </main>
  );
}
