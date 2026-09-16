// The workspace directory, read from the replica.
//
// Never the network — which is the point: it keeps answering while offline,
// and that is the property the aeroplane toggle exists to test.
//
// Read through the live-query client, so a directory sync refreshes what is on
// screen. Before that existed this queried once on mount and re-ran only on a
// workspace switch — so an actor arriving through an accepted invitation was
// invisible until the window was reloaded, with no error and no spinner.
import { can, workspace as workspaceTarget } from '@relayed/authz';
import { useSession } from '@/app/state';
import { useQuery } from '@/lib/query';
import { grantsOf } from '@/lib/ipc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useOpenDm } from '@/features/dms/useOpenDm';
import { ActorAvatar } from '@/components/ActorAvatar';

export function People() {
  const { rows: actors, status, error } = useQuery('actors.list');
  const { state } = useSession();
  const { open, opening, failure, offline } = useOpenDm();
  const me = state.workspaces.find(row => row.workspaceId === state.workspaceId)?.actorId;
  const mayMessage = state.workspaceId !== null && can(grantsOf(state), 'create_space', workspaceTarget(state.workspaceId));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Directory</h1>
        <p className="text-sm text-muted-foreground">
          Replicated to this device. No network involved.
          {status === 'offline' && ' Offline — this is what is on disk.'}
        </p>
      </div>

      {/* The three-state matrix (FRONTEND.md §6.2), and `loading` kept distinct
          from `empty`: showing the sign-in copy for the millisecond before the
          first read lands would be a wrong answer, not a slow one. */}
      {status === 'loading' && <p className="text-sm text-muted-foreground">Reading…</p>}

      {status === 'empty' && (
        <p className="text-sm text-muted-foreground">
          Empty — sign in once while online so the directory replicates.
        </p>
      )}

      {/* A failed read keeps the rows it had, so this sits ALONGSIDE the list
          rather than replacing it. Rendering an error over data we still hold
          would be the offline failure this app exists to avoid. */}
      {error && (
        <p className="text-sm text-destructive">Could not refresh the directory: {error}</p>
      )}

      {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}

      {actors && actors.length > 0 && (
        <ul className="max-w-xl divide-y rounded-md border">
          {actors.map(actor => (
            <li key={actor.id} className="flex items-center gap-3 p-3">
              {/* The BLOB, never `avatarUrl` — invariant 46. Absent until the
                  prefetch lands, which is what the monogram is for. */}
              <ActorAvatar id={actor.id} className="size-8" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{actor.displayName}</div>
                <div className="truncate text-xs text-muted-foreground">@{actor.handle}</div>
              </div>
              {actor.type === 'agent' && <Badge variant="outline">agent</Badge>}
              {actor.state !== 'active' && <Badge variant="secondary">{actor.state}</Badge>}
              {/* Opens the DM already there, or starts one. */}
              {mayMessage && actor.state === 'active' && actor.id !== me && (
                <Button variant="outline" size="sm" disabled={opening || offline}
                  title={offline ? 'Starting a conversation needs a connection' : undefined}
                  onClick={() => { void open([actor.id]); }}>
                  Message
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
