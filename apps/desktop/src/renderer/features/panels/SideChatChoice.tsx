// Starting a side chat from the new-panel tab: the choice opens in place into
// a small form, never a dialog (docs/SIDE-CHATS.md §2).
//
// A local room's side chat needs only a name — Claude is always in it. A synced
// room's is started with somebody: people or agents picked from the room, a
// name pre-filled from who was picked, and — for now — public only.
import { useState, type FormEvent, type ReactNode } from 'react';
import { ChatPlus, MultipleCrossCancelDefault } from '@relayed/icons';
import type { Space, SpaceScope } from '../../../preload/api';
import { useSession } from '@/app/state';
import { ActorAvatar } from '@/components/ActorAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useActorLookup } from '@/lib/actors';
import { call } from '@/lib/ipc';
import { useSpaceMembers } from '@/lib/space-members';

/** The server's limit on a side chat's name. */
const NAME_MAX = 80;

export function SideChatChoice({ space, scope, onCreated }: {
  space: Space; scope: SpaceScope;
  /** The panel the new chat is shown in, which the new-panel tab becomes. */
  onCreated: (panelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <EmptyPanelChoice
        icon={<ChatPlus />}
        title="Side chat"
        description={scope === 'local' ? 'Start a public or private conversation.' : 'Start a conversation with people in this room.'}
        onClick={() => setOpen(true)}
      />
    );
  }
  const close = () => setOpen(false);
  return scope === 'local'
    ? <LocalSideChat spaceId={space.id} onCreated={onCreated} onCancel={close} />
    : <RoomSideChat spaceId={space.id} onCreated={onCreated} onCancel={close} />;
}

function LocalSideChat({ spaceId, onCreated, onCancel }: FormProps) {
  const [name, setName] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    void call(api => api.query('local.chats.create', { spaceId, name, kind: isPrivate ? 'private' : 'public' }))
      .then(created => { if (created?.panelId) onCreated(created.panelId); })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
  };

  return (
    <SideChatForm onSubmit={submit} onCancel={onCancel} error={error} canCreate={name.trim().length > 0}>
      <Input autoFocus aria-label="Name" placeholder="try a different fix" value={name} onChange={event => setName(event.target.value)} />
      <PrivateSwitch checked={isPrivate} onChange={setPrivate} />
    </SideChatForm>
  );
}

function RoomSideChat({ spaceId, onCreated, onCancel }: FormProps) {
  const { state } = useSession();
  const roster = useSpaceMembers(spaceId);
  const actorOf = useActorLookup();
  const me = state.workspaces.find(row => row.workspaceId === state.workspaceId)?.actorId;
  const [picked, setPicked] = useState<string[]>([]);
  // The name follows who is picked until it is typed in; after that it is theirs.
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggested = picked.flatMap(id => actorOf(id)?.displayName ?? []).join(', ').slice(0, NAME_MAX);
  const name = typed ?? suggested;
  const candidates = roster.members.filter(member => member.actorId !== me && !picked.includes(member.actorId));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    void call(api => api.query('spaces.createChat', { spaceId, name: name.trim(), kind: 'public', withActorIds: picked }))
      .then(answer => {
        if (!answer) return;
        if (answer.ok) { onCreated(answer.panel_id); return; }
        setError(
          answer.error === 'actor_unavailable' ? 'Someone you picked is no longer in this room.'
          : answer.error === 'forbidden' ? 'You can no longer start side chats in this room.'
          : answer.field === 'name' ? `Give it a name of up to ${NAME_MAX} characters.`
          : 'Could not start the side chat. Please try again.',
        );
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(false));
  };

  return (
    <SideChatForm
      onSubmit={submit} onCancel={onCancel} error={error}
      canCreate={picked.length > 0 && name.trim().length > 0 && !busy && !state.offline}
      busy={busy}
      note={state.offline ? 'Starting a side chat needs a connection.' : null}
    >
      {picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {picked.map(id => (
            <Badge key={id} variant="secondary" className="gap-1 pr-1">
              <ActorAvatar id={id} className="size-4" fallbackClassName="text-[8px]" />
              {actorOf(id)?.displayName ?? 'Someone'}
              <button
                type="button" aria-label={`Remove ${actorOf(id)?.displayName ?? 'person'}`}
                className="rounded-sm opacity-70 hover:opacity-100"
                onClick={() => setPicked(ids => ids.filter(each => each !== id))}
              >
                <MultipleCrossCancelDefault className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Command className="rounded-lg border border-border/70 bg-background">
        <CommandInput autoFocus placeholder="Add people or agents from this room…" />
        <CommandList className="max-h-40">
          {roster.state === 'complete' ? (
            <>
              <CommandEmpty>Nobody else to add.</CommandEmpty>
              {candidates.map(member => {
                const actor = actorOf(member.actorId);
                return (
                  <CommandItem
                    key={member.actorId}
                    value={`${actor?.displayName ?? ''} ${actor?.handle ?? ''} ${member.actorId}`}
                    onSelect={() => setPicked(ids => [...ids, member.actorId])}
                  >
                    <ActorAvatar id={member.actorId} className="size-6" fallbackClassName="text-[10px]" />
                    <span className="min-w-0 flex-1 truncate">{actor?.displayName ?? 'Someone'}</span>
                    {actor?.type === 'agent' && <Badge variant="outline">agent</Badge>}
                  </CommandItem>
                );
              })}
            </>
          ) : (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">Loading who is in this room…</p>
          )}
        </CommandList>
      </Command>
      <Input
        aria-label="Name" placeholder="Name it, or pick people first" maxLength={NAME_MAX}
        value={name} onChange={event => setTyped(event.target.value)}
      />
      {/* Private side chats need the server to keep them from everyone else first (SIDE-CHATS.md §4). */}
      <PrivateSwitch checked={false} onChange={() => {}} disabled hint="Private side chats are coming soon." />
    </SideChatForm>
  );
}

interface FormProps { spaceId: string; onCreated: (panelId: string) => void; onCancel: () => void }

function SideChatForm({ onSubmit, onCancel, error, canCreate, busy = false, note = null, children }: {
  onSubmit: (event: FormEvent) => void; onCancel: () => void; error: string | null;
  canCreate: boolean; busy?: boolean; note?: string | null; children: ReactNode;
}) {
  return (
    <form
      onSubmit={onSubmit}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onCancel(); } }}
      className="space-y-3 rounded-xl border border-border bg-muted/25 px-4 py-3"
    >
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground [&_svg]:size-4">
          <ChatPlus />
        </span>
        <span className="text-sm font-medium">New side chat</span>
      </div>
      {children}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="xs" disabled={!canCreate}>{busy ? 'Starting…' : 'Create'}</Button>
      </div>
    </form>
  );
}

function PrivateSwitch({ checked, onChange, disabled = false, hint = 'Only its members see it, or know it exists.' }: {
  checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; hint?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className={disabled ? 'text-muted-foreground' : undefined}>
        Private
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  );
}

export function EmptyPanelChoice({ icon, title, description, onClick }: {
  icon: ReactNode; title: string; description: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl border border-border/60 bg-muted/25 px-4 py-3 text-left transition-colors hover:border-border hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground group-hover:text-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}
