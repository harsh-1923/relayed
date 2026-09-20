// The two levels of "your build is behind" (docs/RELEASE.md §1).
//
// An OFFER and a REFUSAL are different things, so they are different surfaces.
//
// THE OFFER OVERLAYS, IT DOES NOT DISPLACE. It was a strip above the router,
// which pushed the entire application down the window and read as broken chrome
// rather than as a notice. Nothing about "there is a newer build" justifies
// moving the app someone is using, so it is a fixed card in the corner over the
// top of everything.
//
// IT DOES NOT TIME OUT. A toast that disappears on its own is right for "sent"
// and wrong for this: someone who looks away misses the only signal there is,
// and there is no second channel telling them. It stays until dismissed, and
// dismissal lasts for this window — the next launch offers it again, because
// the update is still not installed.
//
// THE REFUSAL TAKES THE WHOLE WINDOW, deliberately: this build is below the
// floor the server publishes, so there is nothing useful left to overlay.
//
// NEITHER APPEARS WITHOUT AN ANSWER. The sync engine leaves `ok` only on a
// successful response, so an unreachable server shows nothing — R3 says local
// data is fully readable with no network, and a wall on a plane would be the
// exact failure local-first exists to prevent.
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
      // `fixed inset-0`, not `h-dvh`: height alone left the width to whatever
      // layout the root happened to use, so the wall covered part of the window
      // and the translucent material showed through beside it.
      <div className="fixed inset-0 z-50 grid place-items-center bg-background p-8">
        <div className="max-w-sm text-center">
          <h1 className="text-base font-medium">Relayed needs updating</h1>
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
      {children}
      {v.status === 'update_available' && !dismissed && (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-50 w-72 rounded-lg border bg-popover
                     p-3 text-popover-foreground shadow-lg"
        >
          <p className="text-sm font-medium">Version {v.latest} is available</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            You&rsquo;re on {state.version?.current}.
          </p>
          <div className="mt-2.5 flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
              Not now
            </Button>
            <Button size="sm" onClick={() => open(v.url)}>Download</Button>
          </div>
        </div>
      )}
    </>
  );
}
