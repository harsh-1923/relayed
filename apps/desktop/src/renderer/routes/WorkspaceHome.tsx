// The workspace landing page.
//
// A placeholder for the space list that will replace it — §4.6 settles the
// route shape (/w/:wsId/s/:spaceId) and it arrives with the first real
// surface. Until then this is where the rail lands you, and it is the thing
// that proves a switch actually completed.
import { Link } from 'react-router';
import { useSession } from '@/app/state';
import { blobSrc, initials } from '@/lib/ipc';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';

export function WorkspaceHome() {
  const { state } = useSession();
  const active = state.workspaces.find(w => w.workspaceId === state.workspaceId);
  if (!active) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{active.name}</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as @{active.actorHandle}
          </p>
        </div>
        <Badge variant={state.auth.status === 'authenticated' ? 'default' : 'secondary'}>
          {state.auth.status.replace('_', ' ')}
        </Badge>
      </div>

      {state.auth.status === 'stale' && (
        <Alert className="max-w-xl">
          <AlertTitle>Reconnect to sync</AlertTitle>
          <AlertDescription>
            Could not refresh the session ({state.auth.reason}). Local data is
            unaffected, and every route here still renders from disk.
          </AlertDescription>
        </Alert>
      )}

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">You, here</CardTitle>
          <CardDescription>
            Your handle and role are per workspace — they can differ in each one.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Avatar>
            <AvatarImage src={blobSrc(active.actorAvatarBlob)} />
            <AvatarFallback>{initials(active.actorDisplayName)}</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <div className="font-medium">{active.actorDisplayName}</div>
            <div className="text-sm text-muted-foreground">@{active.actorHandle}</div>
          </div>
          <Badge variant="outline">{active.actorRole}</Badge>
        </CardContent>
      </Card>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">Spaces</CardTitle>
          <CardDescription>
            Channels, DMs and rooms land here. The route shape is settled
            (FRONTEND.md §4.6); the surface is not built.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 text-sm">
          <Link to="people" className="text-primary underline-offset-4 hover:underline">
            Directory
          </Link>
          <span className="text-muted-foreground">·</span>
          <Link to="settings/members" className="text-primary underline-offset-4 hover:underline">
            Members
          </Link>
          <span className="text-muted-foreground">·</span>
          <Link to="settings/profile" className="text-primary underline-offset-4 hover:underline">
            Your profile
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
