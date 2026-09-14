// The room's panels, in the space header: which are open, and how to add one
// (PANELS.md §4–§5). Opening and closing only rewrite `?p=`; making a side chat
// or opening a page writes a row, then opens it.
import { useState, type FormEvent } from 'react';
import { ChatDefault, ChatPlus, Globe, LockClose, SidebarRightOpen } from '@relayed/icons';
import type { Panel, Space } from '../../../preload/api';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { call } from '@/lib/ipc';
import type { OpenPanels } from './useOpenPanels';
import { addressFromTyped } from '../../../shared/web-panels.ts';

type Adding = 'chat' | 'web' | null;

export function PanelMenu({ space, panels, openPanels }: { space: Space; panels: readonly Panel[]; openPanels: OpenPanels }) {
  const [adding, setAdding] = useState<Adding>(null);
  const openCount = openPanels.ids.length;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="xs" aria-label="Panels" />}>
          <SidebarRightOpen />
          <span>Panels{openCount > 0 ? ` · ${openCount}` : ''}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {panels.length > 0 && (
            <>
              <DropdownMenuGroup>
                <DropdownMenuLabel>In this room</DropdownMenuLabel>
                {panels.map(panel => (
                  <DropdownMenuCheckboxItem
                    key={panel.id}
                    // Checked when it is an open tab. Choosing an open tab shows it; choosing it
                    // again, once shown, closes it.
                    checked={openPanels.ids.includes(panel.id)}
                    onCheckedChange={() => (openPanels.active === panel.id ? openPanels.close(panel.id) : openPanels.open(panel.id))}
                  >
                    <PanelLabel panel={panel} space={space} />
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={() => setAdding('chat')}>
            <ChatPlus /> New side chat…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setAdding('web')}>
            <Globe /> Open a web page…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={adding !== null} onOpenChange={open => { if (!open) setAdding(null); }}>
        <DialogContent className="sm:max-w-md">
          {adding === 'chat' && <NewSideChat space={space} onDone={id => { setAdding(null); if (id) openPanels.open(id); }} />}
          {adding === 'web' && <OpenWebPage space={space} onDone={id => { setAdding(null); if (id) openPanels.open(id); }} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function PanelLabel({ panel, space }: { panel: Panel; space: Space }) {
  const chat = panel.chatId ? space.chats.find(candidate => candidate.id === panel.chatId) : undefined;
  const Icon = panel.type === 'chat' ? (chat?.kind === 'private' ? LockClose : ChatDefault) : Globe;
  const url = typeof panel.payload['url'] === 'string' ? panel.payload['url'] : '';
  const label = panel.type === 'chat' ? chat?.name ?? panel.title ?? 'Chat' : panel.title ?? url;
  return (
    <>
      <Icon className="text-muted-foreground" />
      <span className="truncate">{label}</span>
    </>
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
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
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
    // The store refuses every scheme but http and https.
    const address = addressFromTyped(url);
    if (!address) return;
    void call(api => api.query('local.panels.open', { spaceId: space.id, type: 'web', payload: { url: address } }))
      .then(opened => onDone(opened?.id ?? null))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
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
