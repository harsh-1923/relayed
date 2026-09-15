// Add a workspace actor to the open space.
//
// Candidates come from the local directory, never a network read. The client
// hides the affordance with the shared evaluator; the server still decides the
// command authoritatively when a candidate is selected.
import { useState } from 'react';
import { can, space as spaceTarget } from '@relayed/authz';
import { UserPlus } from '@relayed/icons';
import { useSession } from '@/app/state';
import { useQuery } from '@/lib/query';
import { blobSrc, call, grantsOf, initials } from '@/lib/ipc';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';

export function AddSpaceMember({ spaceId }: { spaceId: string }) {
  const { state } = useSession();
  const { rows: actors } = useQuery('actors.list');
  const [open, setOpen] = useState(false);
  const [busyActorId, setBusyActorId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const workspace = state.workspaces.find(row => row.workspaceId === state.workspaceId);
  const mayAdd = state.workspaceId !== null && can(
    grantsOf(state), 'add_member', spaceTarget(spaceId),
    { workspaceOf: { [spaceId]: state.workspaceId } },
  );

  if (!mayAdd) return null;

  const candidates = (actors ?? []).filter(actor =>
    actor.state === 'active' && actor.id !== workspace?.actorId);

  async function add(actorId: string) {
    setBusyActorId(actorId);
    setFailure(null);
    try {
      const answer = await call(api => api.query('spaces.addMember', { spaceId, actorId }));
      if (!answer) return;
      // Added, or already were — either way the picker's job is done, per the
      // product rule that a repeated add is a clean no-op, not an error
      // (SPACE-MEMBERSHIP-MARKERS.md).
      if (answer.ok || answer.error === 'already_member') {
        setOpen(false);
        return;
      }
      if (answer.error === 'sealed_space') {
        setFailure('This conversation cannot have members added.');
      } else if (answer.error === 'forbidden') {
        setFailure('You no longer have permission to add people to this space.');
      } else if (answer.error === 'actor_unavailable') {
        setFailure('That actor is no longer available in this workspace.');
      } else {
        setFailure('Could not add that actor.');
      }
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusyActorId(null);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={state.offline}
        title={state.offline ? 'Adding someone needs a connection' : undefined}
        onClick={() => { setFailure(null); setOpen(true); }}
      >
        <UserPlus />
        Add people
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Add people to this space"
        description="Search the workspace directory"
        showCloseButton
      >
        <Command>
          <CommandInput autoFocus placeholder="Search people and agents…" />
          {failure && <p role="alert" className="px-3 py-2 text-sm text-destructive">{failure}</p>}
          <CommandList>
            <CommandEmpty>No active actors found.</CommandEmpty>
            <CommandGroup heading="Workspace directory">
              {candidates.map(actor => (
                <CommandItem
                  key={actor.id}
                  value={`${actor.displayName} ${actor.handle} ${actor.type}`}
                  disabled={busyActorId !== null}
                  onSelect={() => { void add(actor.id); }}
                >
                  <Avatar className="size-7">
                    <AvatarImage src={blobSrc(actor.avatarBlob)} />
                    <AvatarFallback className="text-xs">{initials(actor.displayName)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{actor.displayName}</div>
                    <div className="truncate text-xs text-muted-foreground">@{actor.handle}</div>
                  </div>
                  {actor.type === 'agent' && <Badge variant="outline">agent</Badge>}
                  {busyActorId === actor.id && <span className="text-xs text-muted-foreground">Adding…</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            People already in the space may appear here; adding them again makes no change.
          </p>
        </Command>
      </CommandDialog>
    </>
  );
}
