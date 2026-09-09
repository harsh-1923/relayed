// A URL naming a workspace, turned into a workspace being open.
//
// This is the ONLY caller of workspace.switch (invariant 56). The rail
// navigates, a deep link navigates, back and forward navigate — they all
// arrive here, and there is exactly one input to which workspace is active.
//
// The switch itself is unchanged: it commits `last_workspace` before any handle
// work (invariant 42), bumps the epoch, and returns as soon as the replica is
// open without waiting on a token or a socket (STORAGE.md §12.2). That last
// property is what lets a pasted link resolve on a plane.
import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useParams } from 'react-router';
import { useSession } from './state';
import { call } from '@/lib/ipc';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';

export function WorkspaceGate() {
  const { wsId } = useParams();
  const { state, apply } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const requested = useRef<string | null>(null);

  const row = state.workspaces.find(w => w.workspaceId === wsId);
  const known = row !== undefined && row.state === 'active';
  const active = state.workspaceId === wsId;

  useEffect(() => {
    if (!wsId || active || !known) return;

    // StrictMode runs a mount effect twice, and this effect fires AT MOUNT in
    // exactly one situation: the window loaded straight into a URL whose
    // workspace is not the active one. That is the deep-link path — the case
    // the whole of §4.5 exists for — so without this guard the most important
    // path is also the only one that switches twice and bumps the epoch twice.
    //
    // Navigating between workspaces does not remount the gate (same route,
    // changed param), so it never had the problem and does not need the guard;
    // it is here for the path that does.
    if (requested.current === wsId) return;
    requested.current = wsId;

    // `live` rather than an AbortController: the switch is not cancellable —
    // it has already written last_workspace — so all we may do is decline to
    // apply its answer to a gate that has moved on.
    let live = true;
    setSwitching(true);
    setError(null);
    call(api => api.query('workspace.switch', { workspaceId: wsId }))
      .then(s => { if (live) apply(s); })
      .catch((e: Error) => {
        // Cleared, so retrying the same URL actually retries.
        requested.current = null;
        if (live) setError(e.message);
      })
      .finally(() => { if (live) setSwitching(false); });
    return () => { live = false; };
    // `known` is a boolean, not the row: the row's identity changes on every
    // push, and depending on it would re-issue the switch on every hint update.
  }, [wsId, active, known, apply]);

  if (!wsId) return null;

  if (!known) return <Unresolved id={wsId} offline={state.offline} />;

  if (error) {
    return (
      <Alert variant="destructive" className="max-w-xl">
        <AlertTitle>Could not open {row.name}</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{error}</p>
          <Link to="/" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Go back</Link>
        </AlertDescription>
      </Alert>
    );
  }

  if (switching || !active) {
    return <p className="text-sm text-muted-foreground">Opening {row.name}…</p>;
  }

  // Keyed on the epoch: a switch drops the whole subtree rather than merging,
  // which is the coarsest form of DESIGN §11.2's coarse invalidation.
  return <Outlet key={state.epoch} />;
}

/**
 * A link naming a workspace this device does not hold.
 *
 * Three outcomes are possible — the account is a member and has simply never
 * opened it here, an invitation is pending, or there is no access at all — and
 * telling them apart needs the server (FRONTEND.md §4.5). That resolution is
 * not built yet, so this says what is actually known and no more.
 *
 * Offline it says even less, on purpose. "Not a member" and "not synced yet"
 * are indistinguishable without the network, and asserting the first would be
 * a claim the UI has no basis for (invariant 58).
 */
function Unresolved(props: { id: string; offline: boolean }) {
  return (
    <Alert className="max-w-xl">
      <AlertTitle>
        {props.offline ? 'Cannot check this workspace while offline' : 'Not open on this device'}
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          {props.offline
            ? 'This device has no copy of it, and whether you have access cannot be '
              + 'confirmed without a connection. Everything already on this device '
              + 'still works.'
            : 'This device has no copy of it. Opening a workspace you have not used '
              + 'here before needs the server, which is not wired up yet.'}
        </p>
        <p className="font-mono text-xs text-muted-foreground">{props.id}</p>
        <Link to="/" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Go back</Link>
      </AlertDescription>
    </Alert>
  );
}
