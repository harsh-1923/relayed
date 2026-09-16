// One space: its header, the chat it opens on — a channel's or DM's sole chat,
// a room's default — and, in a room, the panels open beside it.
//
// The route names the SPACE, never a chat (FRONTEND.md §4.6). A room's side
// chats and pages are panels, and which panels are open is view state in the
// query (`?p=`, PANELS.md §8), so there is no chat in the path to disagree with
// the space, and stripping the query still lands in the right place.
import { useEffect, useMemo } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@/lib/query';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ChatView } from '@/features/chat/ChatView';
import { SpaceHeader } from '@/features/chat/SpaceHeader';
import { AddSpaceMember } from '@/features/chat/AddSpaceMember';
import { RoomActivity } from '@/features/local-rooms/RoomActivity';
import { PanelContainer } from '@/features/panels/PanelContainer';
import { useOpenPanels } from '@/features/panels/useOpenPanels';
import { useRoomPanelArrivals } from '@/features/panels/useRoomPanelArrivals';
import { useRoomSummaryTab, withSummaryFirst } from '@/features/documents/useRoomSummaryTab';
import { call } from '@/lib/ipc';
import { useCommand, useCommandHandler } from '@/lib/commands/CommandProvider';
import { Button } from '@/components/ui/button';
import { SidebarRightOpen } from '@relayed/icons';
import { mainChat, type SpaceScope } from '../../shared/spaces.ts';
import { panelContainerToggle, resolveOpenPanels } from '../../shared/panels.ts';

/** The one-space read, by storage scope. Both return the same `Space` rows. */
const SPACE_READ = { workspace: 'space.get', local: 'local.space.get' } as const;

export function Space({ scope = 'workspace' }: { scope?: SpaceScope }) {
  const { spaceId = '' } = useParams();
  const { rows, status, error } = useQuery(SPACE_READ[scope] as 'space.get', { spaceId });
  const space = rows?.[0] ?? null;
  const chat = space ? mainChat(space) : null;

  // Panels are a room's (DESIGN.md §7.1), in either scope. A local room holds
  // them all on this device. A synced room has the room's shared panels — what
  // an agent opened for everyone — and any page opened here on this device
  // alone. Both reads run in both scopes, so the hook order never changes.
  const hasPanels = space?.kind === 'room';
  const { rows: devicePanels, status: devicePanelsStatus } = useQuery('local.panels.list', { spaceId: hasPanels ? spaceId : '' });
  const { rows: roomPanels, status: roomPanelsStatus } = useQuery('panels.list', { spaceId: hasPanels && scope === 'workspace' ? spaceId : '' });
  const panels = useMemo(
    () => (scope === 'workspace' ? [...(roomPanels ?? []), ...(devicePanels ?? [])] : (devicePanels ?? [])),
    [scope, roomPanels, devicePanels],
  );
  const panelsStatus = scope === 'workspace' && roomPanelsStatus === 'loading' ? 'loading' : devicePanelsStatus;
  const openPanels = useOpenPanels();
  // The room's summary leads the strip whatever else is open (DOCUMENTS.md §8.1).
  const open = withSummaryFirst(resolveOpenPanels(openPanels.ids, panels), panels);
  useRoomSummaryTab({
    enabled: hasPanels && scope === 'workspace', ready: panelsStatus !== 'loading', spaceId, panels, openPanels,
  });
  useRoomPanelArrivals({
    enabled: hasPanels && scope === 'workspace', ready: panelsStatus !== 'loading', spaceId, panels, openPanels,
  });

  useCommandHandler('room.panels.toggle', {
    layer: 'route',
    enabled: hasPanels && panelsStatus !== 'loading',
    run: () => {
      const action = panelContainerToggle(openPanels.containerOpen, panels);
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
                {/* Nobody is added to a DM or group message: adding someone is a new conversation. */}
                {scope === 'workspace' && space.kind !== 'dm' && space.kind !== 'group_dm' && <AddSpaceMember spaceId={spaceId} />}
                {/* Everything about panels lives in their container; the header only opens it. */}
                {hasPanels && !openPanels.containerOpen && <OpenPanelsButton />}
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
            <PanelContainer tabs={open} panels={panels} space={space} scope={scope} openPanels={openPanels} />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

/** Opens the room's panels — the same command as its shortcut, so the two cannot differ. */
function OpenPanelsButton() {
  const toggle = useCommand('room.panels.toggle');
  return (
    <Button
      variant="ghost" size="xs"
      title={toggle.shortcutLabel ? `Open panels (${toggle.shortcutLabel})` : 'Open panels'}
      aria-keyshortcuts={toggle.ariaKeyShortcuts}
      onClick={() => toggle.execute()}
    >
      <SidebarRightOpen />
      <span>Open panels</span>
    </Button>
  );
}
