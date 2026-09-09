// The workspace directory, read from the replica.
//
// Never the network — which is the point: it keeps answering while offline,
// and that is the property the aeroplane toggle exists to test.
//
// This still queries imperatively on mount. The live-query client (§5) is the
// next thing built, and this is the first surface that will move onto it: it
// is a list that an invalidation should refresh, and today nothing refreshes it.
import { useEffect, useState } from 'react';
import type { ReplicaActor } from '../../preload/api';
import { useSession } from '@/app/state';
import { call, blobSrc, initials } from '@/lib/ipc';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';

export function People() {
  const { state } = useSession();
  const [actors, setActors] = useState<ReplicaActor[] | null>(null);

  useEffect(() => {
    let live = true;
    void call(api => api.query('actors.list'))
      .then(v => { if (live) setActors(v ?? []); })
      .catch(() => { if (live) setActors([]); });
    return () => { live = false; };
  }, [state.epoch]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Directory</h1>
        <p className="text-sm text-muted-foreground">
          Replicated to this device. No network involved.
        </p>
      </div>

      {actors === null && <p className="text-sm text-muted-foreground">Reading…</p>}

      {actors?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Empty — sign in once while online so the directory replicates.
        </p>
      )}

      {actors && actors.length > 0 && (
        <ul className="max-w-xl divide-y rounded-md border">
          {actors.map(a => (
            <li key={a.id} className="flex items-center gap-3 p-3">
              {/* The BLOB, never `avatarUrl` — invariant 46. Absent until the
                  prefetch lands, which is what the monogram is for. */}
              <Avatar className="size-8">
                <AvatarImage src={blobSrc(a.avatarBlob)} />
                <AvatarFallback>{initials(a.displayName)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{a.displayName}</div>
                <div className="truncate text-xs text-muted-foreground">@{a.handle}</div>
              </div>
              {a.type === 'agent' && <Badge variant="outline">agent</Badge>}
              {a.state !== 'active' && <Badge variant="secondary">{a.state}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
