// A workspace we have been admitted to and have no actor in yet
// (PHASE-1-IDENTITY §9).
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import type { PendingJoin } from '../../preload/api';
import { useSession } from '@/app/state';
import { call } from '@/lib/ipc';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function JoinWorkspace() {
  const { state, apply } = useSession();
  const joins = state.auth.status === 'needs_workspace' ? state.auth.pendingJoins : [];
  const [pick, setPick] = useState<PendingJoin | null>(joins[0] ?? null);
  const [handle, setHandle] = useState(joins[0]?.handleSuggestions[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  if (joins.length === 0) return <Navigate replace to="/onboarding/create" />;

  const join = async () => {
    if (!pick) return;
    setBusy(true); setError(null);
    try {
      const s = await call(api =>
        api.query('auth.join', { workspaceId: pick.workspaceId, handle }));
      if (s) {
        apply(s);
        void navigate(`/w/${pick.workspaceId}`, { replace: true });
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>You have been invited</CardTitle>
        <CardDescription>
          Choose a handle for this workspace. Handles are per workspace, so one you
          use elsewhere may already be taken here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not join</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {joins.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {joins.map(j => (
              <Button key={j.workspaceId} size="sm"
                      variant={j.workspaceId === pick?.workspaceId ? 'secondary' : 'ghost'}
                      onClick={() => { setPick(j); setHandle(j.handleSuggestions[0] ?? ''); }}>
                {j.name}
              </Button>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="join-handle">Your handle in {pick?.name}</Label>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">@</span>
            <Input id="join-handle" value={handle}
                   onChange={(e) => setHandle(e.target.value.toLowerCase())} />
          </div>
          {(pick?.handleSuggestions.length ?? 0) > 1 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {pick?.handleSuggestions.map(sug => (
                <Button key={sug} size="sm" variant={sug === handle ? 'secondary' : 'ghost'}
                        onClick={() => setHandle(sug)}>@{sug}</Button>
              ))}
            </div>
          )}
        </div>

        <Button onClick={() => void join()} disabled={busy || handle.length < 3}>
          {busy ? 'Joining…' : `Join ${pick?.name ?? ''}`}
        </Button>
      </CardContent>
    </Card>
  );
}
