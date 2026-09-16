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
// IN THE TOP BAR, which is at the root of the tree. It was a fixed-position card
// before, for a reason that still holds and is now held by the bar instead: a
// control that can cut the network must be reachable from every screen,
// including the ones a cut network strands you on. It first lived inside the
// shell, which put it on workspace routes and nowhere else — so going offline,
// signing out, and landing on /signin left the app offline with no way to turn
// it back on, and two sign-in attempts failed for a reason the screen could not
// show. A switch that can strand you is worse than no switch.
import { useState } from 'react';
import { WifiOff, WifiOn } from '@relayed/icons';
import { useSession } from '@/app/state';
import { call } from '@/lib/ipc';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function OfflineSwitch() {
  const { state, apply } = useSession();
  const [busy, setBusy] = useState(false);
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
    <div className="no-drag flex items-center gap-1">
      {/* OFFLINE IS LOUD ON PURPOSE. It is a state you can forget you are in,
          and everything it breaks breaks in a way that looks like a bug. */}
      <Button
        size="sm" variant={off ? 'default' : 'ghost'}
        onClick={() => void toggle()} disabled={busy}
        className={cn('h-7 gap-1.5 px-2 text-xs',
                      off ? 'bg-amber-500 text-black hover:bg-amber-400'
                          : 'text-muted-foreground hover:text-foreground')}
      >
        {off ? <WifiOff className="size-3.5" /> : <WifiOn className="size-3.5" />}
        {off && 'Offline'}
      </Button>
    </div>
  );
}
