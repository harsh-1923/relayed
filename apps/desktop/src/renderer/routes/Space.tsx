// One space: its header, the chat it opens on — a channel's or DM's sole chat,
// a room's default — and, in a room, the panels open beside it.
//
// The route names the SPACE, never a chat (FRONTEND.md §4.6). A room's side
// chats and pages are panels, and which panels are open is view state in the
// query (`?p=`, PANELS.md §8), so there is no chat in the path to disagree with
// the space, and stripping the query still lands in the right place.
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@/lib/query';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ChatView } from '@/features/chat/ChatView';
import { SpaceHeader } from '@/features/chat/SpaceHeader';
import { AddSpaceMember } from '@/features/chat/AddSpaceMember';
import { SpaceMembers } from '@/features/chat/SpaceMembers';
import { RoomActivity } from '@/features/local-rooms/RoomActivity';
import { PanelContainer } from '@/features/panels/PanelContainer';
import { useOpenPanels } from '@/features/panels/useOpenPanels';
import { useRoomPanelArrivals } from '@/features/panels/useRoomPanelArrivals';
import { useRoomSummaryTab, withSummaryFirst } from '@/features/documents/useRoomSummaryTab';
import { call } from '@/lib/ipc';
import { pointPanel, useAnnotationRequests, useLinkRequests } from '@/lib/panel-navigation';
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

  // Clicking a passage in a message (docs/ANNOTATIONS.md). Opened as an
  // ordinary device-local page, at the passage — the store returns the panel
  // already there when the same address is opened twice, so nothing here has
  // to reason about which tabs exist.
  useAnnotationRequests(hasPanels ? spaceId : '', address => {
    void call(api => api.query('local.panels.open', {
      spaceId, type: 'web', payload: { url: address },
    })).then(opened => {
      if (!opened?.id) return;
      // An id the room already knew is a page already open — the store returns
      // the same panel for the same address. A NEW panel loads at the passage
      // on its own, so pointing it too would only load it twice.
      const known = panels.some(panel => panel.id === opened.id);
      openPanels.open(opened.id);
      if (known) pointPanel(opened.id, address);
    }).catch(() => { /* a room that cannot open a panel says so by not opening one */ });
  });

  // A link in one of the room's pages that wants a tab: a page on this device
  // only, as any page opened here is. The same address already open is that tab.
  useLinkRequests(hasPanels ? spaceId : '', ({ address, background }) => {
    void call(api => api.query('local.panels.open', { spaceId, type: 'web', payload: { url: address } }))
      .then(opened => {
        if (!opened?.id) return;
        if (background) openPanels.add(opened.id);
        else openPanels.open(opened.id);
      })
      .catch(() => { /* a room that cannot open a panel says so by not opening one */ });
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
      // Reopened as this person left it; the newest panel only stands in for a room never opened here.
      if (action.panelId && !openPanels.remembered) openPanels.open(action.panelId);
      else openPanels.openContainer();
    },
  });

  // A browser's new tab: the container opens (with its tabs, if it was closed)
  // on the new-panel tab, its address bar focused. Counted, so pressing it
  // again with the tab already open still puts the cursor back in the bar.
  const [addressFocus, setAddressFocus] = useState(0);
  useCommandHandler('room.panels.newTab', {
    layer: 'route',
    enabled: hasPanels && panelsStatus !== 'loading',
    run: () => {
      if (!openPanels.newTabOpen || !openPanels.containerOpen) openPanels.openNewTab();
      setAddressFocus(count => count + 1);
    },
  });

  // Canonicalise the URL once the room's panels are known: a chat id becomes
  // its panel's id, and an id that matches nothing leaves (§8).
  const resolvedKey = open.map(panel => panel.id).join(',');
  const { ids, active, replace } = openPanels;
  useEffect(() => {
    // `open` always holds the room's summary, so with the container closed it
    // never matches the empty `?p=` and would write the summary back in —
    // reopening the container somebody just closed.
    if (panelsStatus === 'loading' || !openPanels.containerOpen) return;
    if (resolvedKey === ids.join(',')) return;
    const resolved = resolvedKey ? resolvedKey.split(',') : [];
    const shown = open.find(panel => panel.id === active || panel.chatId === active)?.id ?? null;
    replace(resolved, shown);
  }, [panelsStatus, resolvedKey, ids, active, replace]); // eslint-disable-line react-hooks/exhaustive-deps

  // A local panel looked at is kept from the sweep (§5.5). A hidden one is not looked at.
  const shownPanel = openPanels.containerOpen ? open.find(panel => panel.id === active) : undefined;
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
                {/* A DM is between the people its name already says. */}
                {scope === 'workspace' && space.kind !== 'dm' && <SpaceMembers spaceId={spaceId} />}
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
            <PanelContainer tabs={open} panels={panels} space={space} scope={scope} openPanels={openPanels} addressFocus={addressFocus} />
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
