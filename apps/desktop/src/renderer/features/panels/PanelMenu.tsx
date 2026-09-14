// The room's panels, in the space header: which are open, and how to add one
// (PANELS.md §4–§5). Opening and closing only rewrite `?p=`; making a side chat
// or opening a page writes a row, then opens it.
import { useState } from 'react';
import { ChatDefault, ChatPlus, Globe, LockClose, SidebarRightOpen } from '@relayed/icons';
import type { Panel, Space } from '../../../preload/api';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { OpenPanels } from './useOpenPanels';
import { PanelCreationDialog, type PanelCreationKind } from './PanelCreationDialog';

export function PanelMenu({ space, panels, openPanels }: { space: Space; panels: readonly Panel[]; openPanels: OpenPanels }) {
  const [adding, setAdding] = useState<PanelCreationKind>(null);
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

      <PanelCreationDialog
        kind={adding}
        space={space}
        onKindChange={setAdding}
        onCreated={id => { setAdding(null); if (id) openPanels.open(id); }}
      />
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
