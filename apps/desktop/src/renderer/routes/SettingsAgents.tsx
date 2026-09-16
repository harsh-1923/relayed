// Settings → Agents: every agent in the workspace, read from the replica
// (WORKSPACE-AGENTS.md §4.1). Offline it still lists what is on disk; only
// creating and editing need the server.
import { Link } from 'react-router';
import { can, workspace as wsTarget } from '@relayed/authz';
import { useSession } from '@/app/state';
import { useQuery } from '@/lib/query';
import { grantsOf } from '@/lib/ipc';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { ActorAvatar } from '@/components/ActorAvatar';
import { useActorLookup } from '@/lib/actors';

export function SettingsAgents() {
  const { state } = useSession();
  const { rows: actors, status } = useQuery('actors.list');
  const agents = (actors ?? []).filter(actor => actor.type === 'agent');
  const actorOf = useActorLookup();
  const nameOf = (id: string | null) => actorOf(id)?.displayName ?? 'someone';
  const wsId = state.workspaceId;
  // Hidden, not disabled, where the replica says the action does not exist.
  // The server decides; this only spares a button that would always fail.
  const mayCreate = wsId ? can(grantsOf(state), 'create_agent', wsTarget(wsId)) : false;

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Agents act for whoever mentions them. Anyone here can read what each one was told.
        </p>
        {mayCreate && <Link to="new" className={buttonVariants()}>New agent</Link>}
      </div>

      {status === 'loading' && <p className="text-sm text-muted-foreground">Reading…</p>}
      {status !== 'loading' && agents.length === 0 && (
        <p className="text-sm text-muted-foreground">No agents in this workspace yet.</p>
      )}

      <ul className="divide-y rounded-lg border">
        {agents.map(agent => (
          <li key={agent.id}>
            <Link to={agent.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50">
              <ActorAvatar id={agent.id} className="size-8" fallbackClassName="text-xs" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{agent.displayName}</span>
                  <span className="text-sm text-muted-foreground">@{agent.handle}</span>
                  {agent.state !== 'active' && <Badge variant="outline">{agent.state}</Badge>}
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  {agent.agent?.description || 'No description'} · created by {nameOf(agent.ownerActorId)}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
