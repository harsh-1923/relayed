// The two levels of "your build is behind" (docs/RELEASE.md §1).
//
// An OFFER and a REFUSAL are different things, so they are different surfaces.
// `update_available` is a strip you can dismiss and keep working past.
// `update_required` replaces the app: this build is below the floor the server
// publishes, and pretending it still works would mean writes that the server
// will reject and a person who cannot tell why.
//
// NEITHER APPEARS WITHOUT AN ANSWER. The sync engine only leaves `ok` on a
// successful response, so an unreachable server shows nothing at all — R3 says
// local data is fully readable with no network, and a wall on a plane would be
// the exact failure the local-first design exists to prevent.
import { useState, type ReactNode } from 'react';
import { useSession } from '@/app/state';
import { Button } from '@/components/ui/button';

/** Opens in the SYSTEM browser: a download is not something this window does. */
const open = (url: string) => { if (url) window.open(url, '_blank', 'noopener'); };

export function UpdateGate({ children }: { children: ReactNode }) {
  const { state } = useSession();
  const v = state.version?.state ?? { status: 'ok' as const };
  const [dismissed, setDismissed] = useState(false);

  if (v.status === 'update_required') {
    return (
      <div className="grid h-dvh place-items-center bg-background p-8">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-medium">Relayed needs updating</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This version ({state.version?.current}) is no longer supported.
            Version {v.minimum} or newer is required to continue.
          </p>
          <div className="mt-5">
            <Button onClick={() => open(v.url)}>Download {v.latest}</Button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Your messages are safe on this device and will still be here after you update.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {v.status === 'update_available' && !dismissed && (
        <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-3 py-1.5 text-sm">
          <span className="text-muted-foreground">
            Version {v.latest} is available. You have {state.version?.current}.
          </span>
          <span className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => open(v.url)}>Download</Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>Dismiss</Button>
          </span>
        </div>
      )}
      {children}
    </>
  );
}
