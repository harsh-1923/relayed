// Workspaces you have been admitted to and have no actor in yet
// (PHASE-1-IDENTITY §9).
//
// ACCOUNT TIER, NOT WORKSPACE TIER, and that is the whole reason this page
// exists rather than a tab under /w/:wsId/settings. A pending join is about a
// workspace you are NOT in: there is no replica open for it, nothing to scope
// the page to, and the workspace you happen to be looking at is unrelated to
// the one inviting you.
//
// Why a join needs a screen at all: accepting an invitation makes you a member
// of the ORGANISATION at WorkOS, which does not create your actor here. An
// actor needs a handle, handles are unique within a workspace, and the one you
// use elsewhere may be taken. So somebody has to choose, and this is where.
import { useState } from 'react';
import { useNavigate } from 'react-router';
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

export function AccountSettingsInvitations() {
  const { state, apply } = useSession();
  const joins = pendingJoinsOf(state.auth);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-medium">Invitations</h2>
        <p className="text-sm text-muted-foreground">
          Workspaces you have been invited to and have not joined yet.
        </p>
      </div>
      {joins.length === 0
        ? (
          <p className="text-sm text-muted-foreground">
            Nothing pending. An invitation appears here once you accept it in the
            email you were sent.
          </p>
        )
        : joins.map(join => <JoinCard key={join.workspaceId} join={join} apply={apply} />)}
    </div>
  );
}

/**
 * Pending joins ride on BOTH `needs_workspace` and `authenticated`.
 *
 * The second is the case this page is for: somebody who already had a workspace
 * when the invitation arrived. Reading only the first is the bug that made this
 * page necessary (session.ts).
 */
function pendingJoinsOf(auth: ReturnType<typeof useSession>['state']['auth']): PendingJoin[] {
  if (auth.status === 'needs_workspace') return auth.pendingJoins;
  if (auth.status === 'authenticated') return auth.pendingJoins;
  return [];
}

function JoinCard(
  { join, apply }: { join: PendingJoin; apply: ReturnType<typeof useSession>['apply'] },
) {
  const [handle, setHandle] = useState(join.handleSuggestions[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const joinNow = async () => {
    setBusy(true); setError(null);
    try {
      // The same call the first-run screen makes. It takes the workspace as an
      // argument and never assumed a first workspace, which is why this page
      // needed no server or protocol change.
      const s = await call(api => api.query('auth.join', { workspaceId: join.workspaceId, handle }));
      if (s) {
        apply(s);
        void navigate(`/w/${join.workspaceId}`, { replace: true });
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{join.name}</CardTitle>
        <CardDescription>
          Choose the handle people will use to mention you in this workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not join</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`handle-${join.workspaceId}`}>Handle</Label>
          <Input
            id={`handle-${join.workspaceId}`}
            value={handle}
            onChange={e => setHandle(e.target.value)}
            placeholder={join.handleSuggestions[0] ?? 'handle'}
          />
        </div>
        <div>
          <Button onClick={() => void joinNow()} disabled={busy || handle.trim().length === 0}>
            {busy ? 'Joining…' : `Join ${join.name}`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
