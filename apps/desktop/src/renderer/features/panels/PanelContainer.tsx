// The panel container: every open panel as a tab, and the one shown beneath
// them (PANELS.md §10). One panel is shown at a time; opening another adds a
// tab rather than splitting the pane again.
//
// A type this build does not know is kept and drawn as a placeholder, never
// dropped: a newer version wrote it (§3.3). A body that throws is caught here,
// so one broken panel does not take the container or the chat with it.
import { Component, useState, type ComponentType, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ChatDefault, Globe, LockClose, MultipleCrossCancelDefault, Notebook, PlusDefault, Refresh, UploadUp } from '@relayed/icons';
import type { Panel, PanelMeta, Space, SpaceScope } from '../../../preload/api';
import { ActorAvatar } from '@/components/ActorAvatar';
import { AvatarGroup, AvatarGroupCount } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ChatView } from '@/features/chat/ChatView';
import { blobSrc, call } from '@/lib/ipc';
import { useQuery } from '@/lib/query';
import { useActorLookup } from '@/lib/actors';
import { cn } from '@/lib/utils';
import type { OpenPanels } from './useOpenPanels';
import { AddressBar, UrlBarButton, WebPanel } from './WebPanel';
import { DocPanel } from '../documents/DocPanel';
import { SideChatChoice } from './SideChatChoice';
import { documentIdOfPanel, isStructuralPanel } from '../../../shared/documents.ts';
import './panels.css';

interface PanelBodyProps {
  panel: Panel; space: Space; scope: SpaceScope;
  /** Put a panel this body opened into the tab strip and show it — creating one only makes the row. */
  onOpenPanel: (panelId: string) => void;
}

/** Bodies drawn only while their tab is shown. A `web` panel is not here: its page stays mounted while its tab is open. */
const PANEL_BODIES: Partial<Record<string, ComponentType<PanelBodyProps>>> = {
  chat: ({ panel, space, scope }) => (panel.chatId ? <ChatView spaceId={space.id} chatId={panel.chatId} scope={scope} /> : null),
  doc: ({ panel, space, onOpenPanel }) => <DocumentBody panel={panel} spaceId={space.id} onOpenPanel={onOpenPanel} />,
};

/** The document this panel is a window onto, from the space's own documents. */
function DocumentBody({ panel, spaceId, onOpenPanel }: {
  panel: Panel; spaceId: string; onOpenPanel: (panelId: string) => void;
}) {
  const { rows: documents } = useQuery('documents.list', { spaceId });
  const documentId = documentIdOfPanel(panel);
  return (
    <DocPanel
      spaceId={spaceId}
      document={documents?.find(row => row.id === documentId) ?? null}
      onOpenPanel={onOpenPanel}
    />
  );
}

export function PanelContainer({ tabs, panels, space, scope, openPanels, addressFocus }: {
  /** The open tabs, in order. */
  tabs: readonly Panel[];
  /** Every panel the room has, open or not — what the new-panel tab offers to reopen. */
  panels: readonly Panel[];
  space: Space; scope: SpaceScope; openPanels: OpenPanels;
  /** Bumped by the new-tab shortcut: put the cursor in the new-panel tab's address bar. */
  addressFocus: number;
}) {
  const actorOf = useActorLookup();
  const { rows: metaRows, status: metaStatus } = useQuery('local.panels.meta', { spaceId: space.id });
  const metaOf = (panel: Panel): PanelMeta => metaRows?.find(row => row.panelId === panel.id)?.meta ?? {};
  /** "opened by @triage for Alice" — who put a shared page in front of the room, and whose request it was. */
  const attributionOf = (panel: Panel): string | null => {
    if (panel.scope !== 'shared' || !panel.createdByActorId) return null;
    const by = actorOf(panel.createdByActorId);
    const forWhom = actorOf(panel.onBehalfOfActorId);
    if (!by) return null;
    const name = by.type === 'agent' ? `@${by.handle}` : by.displayName;
    return forWhom && forWhom.id !== by.id ? `opened by ${name} for ${forWhom.displayName}` : `opened by ${name}`;
  };

  // The new-panel tab is shown while it is open, and whenever there is nothing
  // else to show: an open container with no tabs is that same page.
  const choosing = openPanels.newTabOpen || tabs.length === 0;
  const shown = choosing ? null : (tabs.find(panel => panel.id === openPanels.active) ?? tabs.at(-1) ?? null);
  const Body = shown ? (PANEL_BODIES[shown.type] ?? UnknownPanelBody) : null;

  // The new-panel tab becomes the page: the same address opened twice in a room is the same panel.
  const openAddress = (address: string) =>
    call(api => api.query('local.panels.open', { spaceId: space.id, type: 'web', payload: { url: address } }))
      .then(opened => { if (opened?.id) openPanels.open(opened.id); });

  const share = () => { if (shown) void call(api => api.query('local.panels.share', { panelId: shown.id })); };
  const remove = () => {
    if (!shown) return;
    void call(api => api.query('local.panels.remove', { panelId: shown.id })).then(() => openPanels.close(shown.id));
  };

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label="Panels">
      <div className="flex h-11 shrink-0 items-center gap-1 px-2 border-b border-border/60">
        <div role="tablist" aria-label="Open panels" className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map(panel => (
            <PanelTab
              key={panel.id}
              panel={panel}
              space={space}
              meta={metaOf(panel)}
              attribution={attributionOf(panel)}
              selected={panel.id === shown?.id}
              onSelect={() => openPanels.select(panel.id)}
              onClose={() => openPanels.close(panel.id)}
            />
          ))}
          {choosing && (
            <NewPanelTab onClose={tabs.length > 0 ? openPanels.closeNewTab : openPanels.closeContainer} />
          )}
          {/* A browser's new tab: open what to work beside next. */}
          <Button
            variant="ghost" size="icon-xs" aria-label="New panel" title="New panel"
            className="shrink-0" onClick={openPanels.openNewTab}
          >
            <PlusDefault />
          </Button>
        </div>
        {/* Sharing and removing go through this device's store: a local room's, or a
            page opened here alone. A synced room's shared panels have neither yet. */}
        {shown?.scope === 'local' && scope === 'local' && (
          <Button variant="ghost" size="icon-xs" title="Only on this device. Share it to the room." aria-label="Share to the room" onClick={share}>
            <UploadUp />
          </Button>
        )}
        {shown && shown.type !== 'chat' && (scope === 'local' || shown.scope === 'local') && (
          <Button variant="ghost" size="xs" title={scope === 'local' ? 'Remove from the room' : 'Remove from this device'} onClick={remove} className="hidden">Remove</Button>
        )}
        <Button variant="ghost" size="icon-xs" aria-label="Close panels" title="Close panels" onClick={openPanels.closeContainer}>
          <MultipleCrossCancelDefault />
        </Button>
      </div>
      <div role="tabpanel" className="relative flex min-h-0 flex-1 flex-col">
        {choosing && (
          <NewPanelPage
            space={space}
            scope={scope}
            closed={panels.filter(panel => !tabs.some(tab => tab.id === panel.id))}
            metaOf={metaOf}
            attributionOf={attributionOf}
            onReopen={openPanels.open}
            addressFocus={addressFocus}
            onGo={openAddress}
            onCreated={openPanels.open}
          />
        )}
        {/* Keyed, so a tab switch starts the next panel fresh rather than reusing the last one's state. */}
        {shown && Body && shown.type !== 'web' && (
          <PanelBoundary key={shown.id}>
            <Body panel={shown} space={space} scope={scope} onOpenPanel={openPanels.open} />
          </PanelBoundary>
        )}
        {/* Every open page stays mounted, in tab order, and the ones not shown are parked:
            a webview unmounted or moved loads its page again (WebPanel.tsx). The
            new-panel page parks them all rather than closing them. */}
        {metaStatus !== 'loading' && tabs.filter(panel => panel.type === 'web').map(panel => (
          <PanelBoundary key={panel.id}>
            <WebPanel panel={panel} shown={panel.id === shown?.id} initialUrl={metaOf(panel).currentUrl} />
          </PanelBoundary>
        ))}
      </div>
    </section>
  );
}

/** The new-panel tab itself: always the one shown while it is open. */
function NewPanelTab({ onClose }: { onClose: () => void }) {
  return (
    <div data-selected="true" className="panel-tab group/tab relative flex h-7 max-w-48 min-w-0 shrink-0 items-center overflow-hidden rounded-md px-2 text-xs text-foreground transition-colors">
      <span role="tab" aria-selected className="flex min-w-0 flex-1 items-center gap-1.5">
        <PlusDefault className="size-3.5 shrink-0" />
        <span className="truncate">New panel</span>
      </span>
      <span
        aria-hidden
        className="panel-tab__fade pointer-events-none absolute inset-y-0 right-0 z-[1] w-3 group-hover/tab:w-8 group-focus-within/tab:w-8"
      />
      <button
        type="button" aria-label="Close new panel" onClick={onClose}
        className="pointer-events-none absolute top-1/2 right-1 z-10 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm opacity-0 transition-opacity duration-150 group-hover/tab:pointer-events-auto group-hover/tab:opacity-90 focus-visible:pointer-events-auto focus-visible:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <MultipleCrossCancelDefault className="size-3" />
      </button>
    </div>
  );
}

/**
 * What to open next: a web page, a side chat where a room can have one, or a
 * panel the room already has that is not open on this screen.
 */
function NewPanelPage({ space, scope, closed, metaOf, attributionOf, addressFocus, onGo, onReopen, onCreated }: {
  space: Space; scope: SpaceScope; closed: readonly Panel[];
  metaOf: (panel: Panel) => PanelMeta;
  attributionOf: (panel: Panel) => string | null;
  addressFocus: number;
  onGo: (address: string) => Promise<void>;
  onReopen: (id: string) => void;
  /** A panel made here, which the new-panel tab becomes. */
  onCreated: (id: string) => void;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <>
      {/* A browser's new tab: the web panel's own toolbar, with nowhere to go back to yet. */}
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5">
        <UrlBarButton label="Back" variant="ghost" size="icon-xs" disabled><ArrowLeft /></UrlBarButton>
        <UrlBarButton label="Forward" variant="ghost" size="icon-xs" disabled><ArrowRight /></UrlBarButton>
        <UrlBarButton label="Reload" variant="ghost" size="icon-xs" disabled><Refresh /></UrlBarButton>
        <AddressBar
          url="" disabled={false} focusRequest={addressFocus}
          onGo={address => {
            setFailure(null);
            onGo(address).catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
          }}
        />
      </div>
      {failure && <p className="px-3 pt-2 text-xs text-destructive">{failure}</p>}
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto p-6">
        <div className="w-full max-w-sm">
          <div className="mb-5 text-center">
            <h2 className="text-base font-medium">Open a panel</h2>
            <p className="mt-1 text-sm text-muted-foreground">Type an address above, or pick something to work beside.</p>
          </div>
          <div className="space-y-2">
            <SideChatChoice space={space} scope={scope} onCreated={onCreated} />
          </div>
          <RoomPanels space={space} scope={scope} closed={closed} metaOf={metaOf} attributionOf={attributionOf} onReopen={onReopen} />
        </div>
      </div>
    </>
  );
}

/**
 * What the room has that is not open here, in two kinds that read differently:
 * conversations, with the faces of who is in them, and pages, with where they
 * point. One list mixing both made a chat and a page look alike.
 */
function RoomPanels({ space, scope, closed, metaOf, attributionOf, onReopen }: {
  space: Space; scope: SpaceScope; closed: readonly Panel[];
  metaOf: (panel: Panel) => PanelMeta;
  attributionOf: (panel: Panel) => string | null;
  onReopen: (id: string) => void;
}) {
  const chats = closed.filter(panel => panel.type === 'chat');
  const pages = closed.filter(panel => panel.type !== 'chat');
  return (
    <>
      {chats.length > 0 && (
        <RoomSection heading="Side chats" count={chats.length}>
          {chats.map(panel => {
            const chat = space.chats.find(candidate => candidate.id === panel.chatId);
            const isPrivate = chat?.kind === 'private';
            const Icon = isPrivate ? LockClose : ChatDefault;
            return (
              <RoomRow
                key={panel.id}
                onClick={() => onReopen(panel.id)}
                icon={<Icon className="size-4" />}
                title={panelTitle(panel, chat?.name, metaOf(panel))}
                detail={isPrivate ? 'Private' : 'Everyone in the room'}
                aside={panel.chatId ? <ChatFaces chatId={panel.chatId} scope={scope} /> : null}
              />
            );
          })}
        </RoomSection>
      )}
      {pages.length > 0 && (
        <RoomSection heading="Pages" count={pages.length}>
          {pages.map(panel => {
            const meta = metaOf(panel);
            const url = typeof panel.payload['url'] === 'string' ? panel.payload['url'] : null;
            const host = url ? hostOf(url) : null;
            const attribution = attributionOf(panel);
            return (
              <RoomRow
                key={panel.id}
                onClick={() => onReopen(panel.id)}
                icon={<PanelIcon panel={panel} chatKind={undefined} meta={meta} className="size-4" />}
                title={panelTitle(panel, null, meta)}
                detail={[panel.scope === 'local' ? 'Only on this device' : null, host, attribution].filter(Boolean).join(' · ')}
                muted={panel.scope === 'local'}
              />
            );
          })}
        </RoomSection>
      )}
    </>
  );
}

function RoomSection({ heading, count, children }: { heading: string; count: number; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="mb-2 flex items-baseline gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        {heading}<span className="tabular-nums opacity-70">{count}</span>
      </h3>
      <ul className="space-y-0.5">{children}</ul>
    </section>
  );
}

function RoomRow({ icon, title, detail, aside = null, muted = false, onClick }: {
  icon: ReactNode; title: string; detail: string; aside?: ReactNode; muted?: boolean; onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted/60"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-sm', muted && 'italic')}>{title}</span>
          {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
        </span>
        {aside}
      </button>
    </li>
  );
}

/** The first few people in a chat, and how many more. */
function ChatFaces({ chatId, scope }: { chatId: string; scope: SpaceScope }) {
  const read = scope === 'local' ? 'local.chat.participants' : 'chat.participants';
  const { rows } = useQuery(read as 'chat.participants', { chatId });
  const ids = rows ?? [];
  if (ids.length === 0) return null;
  const shown = ids.slice(0, 3);
  return (
    <AvatarGroup className="shrink-0 -space-x-1.5">
      {shown.map(id => <ActorAvatar key={id} id={id} className="size-6" fallbackClassName="text-[9px]" />)}
      {ids.length > shown.length && (
        <AvatarGroupCount className="size-6 text-[10px]">+{ids.length - shown.length}</AvatarGroupCount>
      )}
    </AvatarGroup>
  );
}

const hostOf = (url: string): string | null => {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return null; }
};

function PanelTab({ panel, space, meta, attribution, selected, onSelect, onClose }: {
  panel: Panel; space: Space; meta: PanelMeta; attribution: string | null; selected: boolean; onSelect: () => void; onClose: () => void;
}) {
  const chat = panel.chatId ? space.chats.find(candidate => candidate.id === panel.chatId) : undefined;
  const title = panelTitle(panel, chat?.name, meta);

  return (
    <div
      data-selected={selected}
      className={cn(
        'panel-tab group/tab relative flex h-7 max-w-48 min-w-0 shrink-0 items-center overflow-hidden rounded-md px-2 text-sm transition-colors',
        selected
          ? 'text-foreground'
          : 'text-muted-foreground hover:text-foreground focus-within:text-foreground',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        title={panel.scope === 'local' ? `${title} — only on this device` : attribution ? `${title} — ${attribution}` : title}
        onClick={onSelect}
        onAuxClick={event => { if (event.button === 1) onClose(); }}
        className="flex min-w-0 flex-1 items-center gap-1.5 outline-none"
      >
        <PanelIcon panel={panel} chatKind={chat?.kind} meta={meta} className={cn('size-3.5', panel.scope === 'local' && 'grayscale')} />
        <span className="truncate">{title}</span>
      </button>
      {/* The room's own panel has no close: it is created with the room and
          nobody can lose it (DOCUMENTS.md §8.1). */}
      {!isStructuralPanel(panel) && (
        <>
          <span
            aria-hidden
            className="panel-tab__fade pointer-events-none absolute inset-y-0 right-0 z-[1] w-3 group-hover/tab:w-8 group-focus-within/tab:w-8"
          />
          <button
            type="button"
            aria-label={`Close ${title}`}
            onClick={onClose}
            className="pointer-events-none absolute top-1/2 right-1 z-10 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm opacity-0 transition-opacity duration-150 group-hover/tab:pointer-events-auto group-hover/tab:opacity-90 focus-visible:pointer-events-auto focus-visible:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <MultipleCrossCancelDefault className="size-3" />
          </button>
        </>
      )}
    </div>
  );
}

/**
 * A panel's icon: a chat's kind, or the page's own icon as this device last saw
 * it, served from the blob store. The globe until one is kept, and if the kept
 * bytes do not draw.
 */
function PanelIcon({ panel, chatKind, meta, className }: {
  panel: Panel; chatKind: string | undefined; meta: PanelMeta; className: string;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  if (panel.type === 'chat') {
    const Icon = chatKind === 'private' ? LockClose : ChatDefault;
    return <Icon className={cn('shrink-0', className)} />;
  }
  if (panel.type === 'doc') return <Notebook className={cn('shrink-0', className)} />;
  const src = blobSrc(meta.iconBlob);
  if (!src || broken === src) return <Globe className={cn('shrink-0', className)} />;
  return <img src={src} alt="" draggable={false} onError={() => setBroken(src)} className={cn('shrink-0 rounded-[3px] object-contain', className)} />;
}

/** What a panel is called: its chat's name, its own title, the page's title as last seen, or where a page points. */
export function panelTitle(panel: Panel, chatName: string | null | undefined, meta: PanelMeta = {}): string {
  if (panel.type === 'chat') return chatName ?? panel.title ?? 'Chat';
  if (panel.title) return panel.title;
  if (meta.pageTitle) return meta.pageTitle;
  const url = typeof panel.payload['url'] === 'string' ? panel.payload['url'] : null;
  if (url) {
    try { return new URL(url).host; } catch { return url; }
  }
  return panel.type;
}

function UnknownPanelBody({ panel }: PanelBodyProps) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      This {panel.type} panel needs a newer version of Relayed.
    </div>
  );
}

class PanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return <p className="p-6 text-sm text-muted-foreground">This panel could not be drawn.</p>;
    }
    return this.props.children;
  }
}
