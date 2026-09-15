// One space: its header, the chat it opens on — a channel's or DM's sole chat,
// a room's default — and, in a room, the panels open beside it.
//
// The route names the SPACE, never a chat (FRONTEND.md §4.6). A room's side
// chats and pages are panels, and which panels are open is view state in the
// query (`?p=`, PANELS.md §8), so there is no chat in the path to disagree with
// the space, and stripping the query still lands in the right place.
import { useEffect } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@/lib/query';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ChatView } from '@/features/chat/ChatView';
import { SpaceHeader } from '@/features/chat/SpaceHeader';
import { AddSpaceMember } from '@/features/chat/AddSpaceMember';
import { RoomActivity } from '@/features/local-rooms/RoomActivity';
import { PanelContainer } from '@/features/panels/PanelContainer';
import { PanelMenu } from '@/features/panels/PanelMenu';
import { useOpenPanels } from '@/features/panels/useOpenPanels';
import { call } from '@/lib/ipc';
import { useCommandHandler } from '@/lib/commands/CommandProvider';
import { mainChat, type SpaceScope } from '../../shared/spaces.ts';
import { panelContainerToggle, resolveOpenPanels } from '../../shared/panels.ts';

/** The one-space read, by storage scope. Both return the same `Space` rows. */
const SPACE_READ = { workspace: 'space.get', local: 'local.space.get' } as const;

export function Space({ scope = 'workspace' }: { scope?: SpaceScope }) {
  const { spaceId = '' } = useParams();
  const { rows, status, error } = useQuery(SPACE_READ[scope] as 'space.get', { spaceId });
  const space = rows?.[0] ?? null;
  const chat = space ? mainChat(space) : null;

  // Panels are a room's (DESIGN.md §7.1). Only a local room holds them today:
  // shared rooms currently open only their default chat. Panel creation and
  // storage remain local — one hook order in both scopes.
  const hasPanels = scope === 'local' && space?.kind === 'room';
  const { rows: panels, status: panelsStatus } = useQuery('local.panels.list', { spaceId: hasPanels ? spaceId : '' });
  const openPanels = useOpenPanels();
  const open = resolveOpenPanels(openPanels.ids, panels ?? []);

  useCommandHandler('room.panels.toggle', {
    layer: 'route',
    enabled: hasPanels && panelsStatus !== 'loading',
    run: () => {
      const action = panelContainerToggle(openPanels.containerOpen, panels ?? []);
      if (action.kind === 'close') {
        openPanels.closeContainer();
        return;
      }
      if (action.panelId) openPanels.open(action.panelId);
      else openPanels.openContainer();
    },
  });

  // Canonicalise the URL once the room's panels are known: a chat id becomes
  // its panel's id, and an id that matches nothing leaves (§8).
  const resolvedKey = open.map(panel => panel.id).join(',');
  const { ids, active, replace } = openPanels;
  useEffect(() => {
    if (panelsStatus === 'loading') return;
    if (resolvedKey === ids.join(',')) return;
    const resolved = resolvedKey ? resolvedKey.split(',') : [];
    const shown = open.find(panel => panel.id === active || panel.chatId === active)?.id ?? null;
    replace(resolved, shown);
  }, [panelsStatus, resolvedKey, ids, active, replace]); // eslint-disable-line react-hooks/exhaustive-deps

  // A local panel looked at is kept from the sweep (§5.5).
  const shownPanel = open.find(panel => panel.id === active);
  useEffect(() => {
    if (shownPanel?.scope === 'local') void call(api => api.query('local.panels.touch', { panelId: shownPanel.id }));
  }, [shownPanel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status === 'loading' && error === null) return null;
  if (!space || !chat) {
    return <p className="p-6 text-sm text-muted-foreground">This space is not on this device.</p>;
  }

  // With no tab open the space takes the whole pane, header included. With
  // any open, the pane splits: the space on the left keeps its header, and the
  // panel container on the right has its own row of tabs in the same line.
  return (
    <ResizablePanelGroup id={`space-${spaceId}`} orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel id="space" minSize={360} className="min-h-0 min-w-0">
        <div className="flex h-full min-h-0 flex-col">
          <SpaceHeader
            spaceId={spaceId}
            scope={scope}
            details={(
              <>
                {scope === 'local' && <RoomActivity spaceId={spaceId} />}
                {scope === 'workspace' && <AddSpaceMember spaceId={spaceId} />}
                {hasPanels && <PanelMenu space={space} panels={panels ?? []} openPanels={openPanels} />}
              </>
            )}
          />
          {/* Keyed by chat, so moving between spaces starts a fresh scroller and composer. */}
          <ChatView key={chat.id} spaceId={spaceId} chatId={chat.id} scope={scope} />
        </div>
      </ResizablePanel>
      {openPanels.containerOpen && (
        <>
          <ResizableHandle />
          <ResizablePanel id="panels" defaultSize="42%" minSize={320} className="min-h-0 min-w-0">
            <PanelContainer tabs={open} space={space} scope={scope} openPanels={openPanels} />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
