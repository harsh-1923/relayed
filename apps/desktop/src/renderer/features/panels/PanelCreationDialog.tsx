import { useState, type FormEvent } from 'react';
import type { Space } from '../../../preload/api';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { call } from '@/lib/ipc';
import { addressFromTyped } from '../../../shared/web-panels.ts';

export type PanelCreationKind = 'chat' | 'web' | null;

export function PanelCreationDialog({ kind, space, onKindChange, onCreated }: {
  kind: PanelCreationKind;
  space: Space;
  onKindChange: (kind: PanelCreationKind) => void;
  onCreated: (panelId: string | null) => void;
}) {
  return (
    <Dialog open={kind !== null} onOpenChange={open => { if (!open) onKindChange(null); }}>
      <DialogContent className="sm:max-w-md">
        {kind === 'chat' && <NewSideChat space={space} onDone={onCreated} />}
        {kind === 'web' && <OpenWebPage space={space} onDone={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

function NewSideChat({ space, onDone }: { space: Space; onDone: (panelId: string | null) => void }) {
  const [name, setName] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    void call(api => api.query('local.chats.create', { spaceId: space.id, name, kind: isPrivate ? 'private' : 'public' }))
      .then(created => onDone(created?.panelId ?? null))
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
  };

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle>New side chat</DialogTitle>
        <DialogDescription>A conversation beside the room's main chat, in a panel.</DialogDescription>
      </DialogHeader>
      <Input autoFocus aria-label="Name" placeholder="try a different fix" value={name} onChange={event => setName(event.target.value)} />
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          Private
          <span className="block text-xs text-muted-foreground">Only its members see it, or know it exists.</span>
        </span>
        <Switch checked={isPrivate} onCheckedChange={setPrivate} />
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="submit" disabled={name.trim().length === 0}>Create</Button>
      </DialogFooter>
    </form>
  );
}

function OpenWebPage({ space, onDone }: { space: Space; onDone: (panelId: string | null) => void }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const address = addressFromTyped(url);
    if (!address) return;
    void call(api => api.query('local.panels.open', { spaceId: space.id, type: 'web', payload: { url: address } }))
      .then(opened => onDone(opened?.id ?? null))
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
  };

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle>Open a web page</DialogTitle>
        <DialogDescription>It opens on this device only, until you share it to the room.</DialogDescription>
      </DialogHeader>
      <Input autoFocus aria-label="Address" placeholder="localhost:5173" value={url} onChange={event => setUrl(event.target.value)} />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="submit" disabled={url.trim().length === 0}>Open</Button>
      </DialogFooter>
    </form>
  );
}
