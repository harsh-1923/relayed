// Account tier: what is true across every workspace on this device
// (STORAGE.md §5). Sign-out lives here because it is an account-level act —
// one identity holds every workspace, and revoking it takes all of them.
import { useCallback, useState } from 'react';
import { useSession } from '@/app/state';
import { call } from '@/lib/ipc';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';

export function Account() {
  const { state, apply } = useSession();
  const [error, setError] = useState<string | null>(null);
  const active = state.workspaces.filter(w => w.state === 'active');

  // The reply is the authoritative post-sign-out state. The push that fires
  // partway through describes a HALF-finished sign-out, so relying on the push
  // alone leaves the UI showing a workspace that is already gone.
  const signOut = useCallback(async () => {
    setError(null);
    try { apply(await call(api => api.query('auth.signOut'))); }
    catch (e) { setError((e as Error).message); }
  }, [apply]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Account</h1>
        <p className="text-sm text-muted-foreground">
          Everything here spans workspaces.
        </p>
      </div>

      {error && (
        <Alert variant="destructive" className="max-w-xl">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">Session</CardTitle>
          <CardDescription>
            WorkOS AuthKit → our session · system browser · PKCE · loopback
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => void signOut()}>
            {active.length > 1 ? `Sign out of all ${active.length}` : 'Sign out'}
          </Button>
        </CardContent>
      </Card>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">Local replica</CardTitle>
          <CardDescription>
            renderer → MessagePort → utilityProcess → SQLite
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 font-mono text-xs text-muted-foreground">
            <dt>install</dt><dd className="truncate">{state.installId}</dd>
            <dt>account</dt><dd className="truncate">{state.accountId ?? '—'}</dd>
            <dt>workspace</dt><dd className="truncate">{state.workspaceId ?? '—'}</dd>
            <dt>replicas</dt><dd>{active.length} known</dd>
            {/* Device-tier and monotonic, so it survives a sign-out. It reset
                to 0 once, when it lived in account.db, and every reply after
                that looked stale (STORAGE.md §8). */}
            <dt>epoch</dt><dd>{state.epoch}</dd>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
