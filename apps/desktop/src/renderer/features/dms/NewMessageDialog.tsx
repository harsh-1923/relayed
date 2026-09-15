// Start a conversation: choose one person for a DM, or several for a group
// message, and open it (DESIGN.md §7.1). Opening the same people again lands in
// the conversation already there — the server decides, not this dialog.
//
// Candidates come from the local directory, like adding someone to a space.
import { useState } from 'react';
import { MultipleCrossCancelDefault } from '@relayed/icons';
import { useSession } from '@/app/state';
import { useQuery } from '@/lib/query';
import { blobSrc, initials } from '@/lib/ipc';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { DM_MAX_MEMBERS } from '../../../shared/spaces.ts';
import { useOpenDm } from './useOpenDm';

export function NewMessageDialog({ onClose }: { onClose: () => void }) {
  const { state } = useSession();
  const { rows: actors } = useQuery('actors.list');
  const { open, opening, failure, offline } = useOpenDm();
  const [chosen, setChosen] = useState<string[]>([]);
  const me = state.workspaces.find(row => row.workspaceId === state.workspaceId)?.actorId;

  const candidates = (actors ?? []).filter(actor => actor.state === 'active' && actor.id !== me);
  const byId = new Map(candidates.map(actor => [actor.id, actor]));
  // The other people a group message may hold: everyone but you.
  const full = chosen.length >= DM_MAX_MEMBERS - 1;

  const toggle = (actorId: string) => setChosen(current =>
    current.includes(actorId) ? current.filter(id => id !== actorId)
    : full ? current : [...current, actorId]);

  const start = async () => {
    if (await open(chosen)) onClose();
  };

  return (
    <CommandDialog
      open
      onOpenChange={next => { if (!next && !opening) onClose(); }}
      title="New message"
      description="Choose one person for a direct message, or several for a group message"
      showCloseButton
    >
      <Command>
        {chosen.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-b px-3 py-2">
            {chosen.map(id => (
              <Badge key={id} variant="secondary" className="gap-1 pr-1">
                {byId.get(id)?.displayName ?? 'Someone'}
                <button type="button" aria-label={`Remove ${byId.get(id)?.displayName ?? 'person'}`}
                  className="rounded-sm opacity-70 hover:opacity-100" onClick={() => toggle(id)}>
                  <MultipleCrossCancelDefault className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <CommandInput autoFocus placeholder="Search people and agents…" />
        <CommandList>
          <CommandEmpty>No one found.</CommandEmpty>
          <CommandGroup heading="Workspace directory">
            {candidates.map(actor => {
              const selected = chosen.includes(actor.id);
              return (
                <CommandItem
                  key={actor.id}
                  value={`${actor.displayName} ${actor.handle} ${actor.type}`}
                  disabled={opening || (full && !selected)}
                  data-checked={selected}
                  onSelect={() => toggle(actor.id)}
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
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
        <div className="flex items-center justify-between gap-3 border-t px-3 py-2">
          <p className={failure ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'} role={failure ? 'alert' : undefined}>
            {failure
              ?? (offline ? 'Connect to start a conversation.'
              : full ? `A group message holds at most ${DM_MAX_MEMBERS} people, you included.`
              : chosen.length > 1 ? 'A group message with everyone chosen.'
              : 'An existing conversation with the same people opens instead of a new one.')}
          </p>
          <Button size="sm" disabled={chosen.length === 0 || opening || offline} onClick={() => { void start(); }}>
            {opening ? 'Opening…' : chosen.length > 1 ? 'Open group message' : 'Open message'}
          </Button>
        </div>
      </Command>
    </CommandDialog>
  );
}
