// The aeroplane, without the aeroplane.
//
// Turning off the wifi to check R3 also stops the dev server, the collector and
// the browser, so what breaks is ambiguous. This cuts the network for the SYNC
// PROCESS only — every outbound call the app makes, and nothing else — which
// makes a failure attributable to the thing being tested.
//
// Rendered only in a development build: `devTools` comes from an env var main
// sets when the app is unpackaged, so in production the control is absent
// rather than hidden.
//
// FIXED-POSITION AND OUTSIDE THE ROUTE TREE, deliberately. It first lived
// inside the shell, which put it on workspace routes and nowhere else — so
// going offline, signing out, and landing on /signin left the app offline with
// no way to turn it back on, and two sign-in attempts failed for a reason the
// screen could not show. A switch that can strand you is worse than no switch.
import { useState } from 'react';
import { useSession } from '@/app/state';
import { call } from '@/lib/ipc';
import { Button } from '@/components/ui/button';

export function DevStrip() {
  const { state, apply } = useSession();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  if (!state.devTools || !state.canGoOffline) return null;

  const off = state.offline;

  const toggle = async () => {
    setBusy(true);
    try {
      apply(await call(api => api.query('dev.setOffline', { offline: !off })));
    } catch {
      // A local IPC call, so this should not happen — but an unhandled
      // rejection from a `void`-invoked handler is the trap this codebase has
      // walked into before (invariant 54).
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed bottom-3 right-3 z-50 max-w-xs">
      <div className={`rounded-lg border bg-card/95 text-card-foreground shadow-lg backdrop-blur
                       ${off ? 'border-amber-500/60' : 'border-border'}`}>
        <div className="flex items-center gap-2 p-2">
          <button onClick={() => setOpen(o => !o)}
                  className="flex-1 text-left text-xs font-medium">
            {off ? '✈︎ Offline (simulated)' : 'Development'}
          </button>
          <Button size="sm" variant={off ? 'default' : 'secondary'}
                  onClick={() => void toggle()} disabled={busy}>
            {off ? 'Go online' : 'Go offline'}
          </Button>
        </div>

        {open && (
          <div className="space-y-2 border-t p-3 text-xs text-muted-foreground">
            <p>
              {off
                ? 'Every outbound call from the sync engine fails. Everything served '
                  + 'from the replica still works.'
                : 'Cuts the network for the sync engine only — the dev server, the '
                  + 'collector and this window keep running.'}
            </p>
            <ol className="list-decimal space-y-1 pl-4">
              <li>Switch workspaces from the rail — the URL changes and the replica
                  opens without a token (STORAGE.md §12.2).</li>
              <li>Reload the window — hash routing lands you back on the same route,
                  rendered from disk (R3).</li>
              <li>Open <span className="font-mono">/people</span> — the directory
                  answers from the replica.</li>
              <li>Sign-in needs the network, so it fails while this is on. That is
                  correct, and this control is why it is recoverable.</li>
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
