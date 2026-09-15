// The panel container: every open panel as a tab, and the one shown beneath
// them (PANELS.md §10). One panel is shown at a time; opening another adds a
// tab rather than splitting the pane again.
//
// A type this build does not know is kept and drawn as a placeholder, never
// dropped: a newer version wrote it (§3.3). A body that throws is caught here,
// so one broken panel does not take the container or the chat with it.
import { Component, useState, type ComponentType, type ReactNode } from 'react';
import { ChatDefault, ChatPlus, Globe, LockClose, MultipleCrossCancelDefault, PlusDefault, UploadUp } from '@relayed/icons';
import type { Panel, PanelMeta, Space, SpaceScope } from '../../../preload/api';
import { Button } from '@/components/ui/button';
import { ChatView } from '@/features/chat/ChatView';
import { blobSrc, call } from '@/lib/ipc';
import { useQuery } from '@/lib/query';
import { cn } from '@/lib/utils';
import type { OpenPanels } from './useOpenPanels';
import { WebPanel } from './WebPanel';
import { PanelCreationDialog, type PanelCreationKind } from './PanelCreationDialog';

interface PanelBodyProps { panel: Panel; space: Space; scope: SpaceScope }

/** Bodies drawn only while their tab is shown. A `web` panel is not here: its page stays mounted while its tab is open. */
const PANEL_BODIES: Partial<Record<string, ComponentType<PanelBodyProps>>> = {
  chat: ({ panel, space, scope }) => (panel.chatId ? <ChatView spaceId={space.id} chatId={panel.chatId} scope={scope} /> : null),
};

export function PanelContainer({ tabs, panels, space, scope, openPanels }: {
  /** The open tabs, in order. */
  tabs: readonly Panel[];
  /** Every panel the room has, open or not — what the new-panel tab offers to reopen. */
  panels: readonly Panel[];
  space: Space; scope: SpaceScope; openPanels: OpenPanels;
}) {
  const [adding, setAdding] = useState<PanelCreationKind>(null);
  const { rows: actors } = useQuery('actors.list');
  const { rows: metaRows } = useQuery('local.panels.meta', { spaceId: space.id });
  const metaOf = (panel: Panel): PanelMeta => metaRows?.find(row => row.panelId === panel.id)?.meta ?? {};
  /** "opened by @triage for Alice" — who put a shared page in front of the room, and whose request it was. */
  const attributionOf = (panel: Panel): string | null => {
    if (panel.scope !== 'shared' || !panel.createdByActorId) return null;
    const by = actors?.find(actor => actor.id === panel.createdByActorId);
    const forWhom = actors?.find(actor => actor.id === panel.onBehalfOfActorId);
    if (!by) return null;
    const name = by.type === 'agent' ? `@${by.handle}` : by.displayName;
    return forWhom && forWhom.id !== by.id ? `opened by ${name} for ${forWhom.displayName}` : `opened by ${name}`;
  };

  // The new-panel tab is shown while it is open, and whenever there is nothing
  // else to show: an open container with no tabs is that same page.
  const choosing = openPanels.newTabOpen || tabs.length === 0;
  const shown = choosing ? null : (tabs.find(panel => panel.id === openPanels.active) ?? tabs.at(-1) ?? null);
  const Body = shown ? (PANEL_BODIES[shown.type] ?? UnknownPanelBody) : null;

  const share = () => { if (shown) void call(api => api.query('local.panels.share', { panelId: shown.id })); };
  const remove = () => {
    if (!shown) return;
    void call(api => api.query('local.panels.remove', { panelId: shown.id })).then(() => openPanels.close(shown.id));
  };
  const created = (id: string | null) => { setAdding(null); if (id) openPanels.open(id); };

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
            onCreate={setAdding}
          />
        )}
        {/* Keyed, so a tab switch starts the next panel fresh rather than reusing the last one's state. */}
        {shown && Body && shown.type !== 'web' && (
          <PanelBoundary key={shown.id}>
            <Body panel={shown} space={space} scope={scope} />
          </PanelBoundary>
        )}
        {/* Every open page stays mounted, in tab order, and the ones not shown are parked:
            a webview unmounted or moved loads its page again (WebPanel.tsx). The
            new-panel page parks them all rather than closing them. */}
        {tabs.filter(panel => panel.type === 'web').map(panel => (
          <PanelBoundary key={panel.id}>
            <WebPanel panel={panel} shown={panel.id === shown?.id} />
          </PanelBoundary>
        ))}
      </div>
      <PanelCreationDialog kind={adding} space={space} onKindChange={setAdding} onCreated={created} />
    </section>
  );
}

/** The new-panel tab itself: always the one shown while it is open. */
function NewPanelTab({ onClose }: { onClose: () => void }) {
  return (
    <div className="group/tab flex h-7 max-w-48 min-w-0 shrink-0 items-center gap-1.5 rounded-md bg-muted/50 pr-1 pl-2 text-xs text-foreground">
      <span role="tab" aria-selected className="flex min-w-0 flex-1 items-center gap-1.5">
        <PlusDefault className="size-3.5 shrink-0" />
        <span className="truncate">New panel</span>
      </span>
      <button
        type="button" aria-label="Close new panel" onClick={onClose}
        className="flex size-4 shrink-0 items-center justify-center rounded-sm opacity-70 hover:bg-muted"
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
function NewPanelPage({ space, scope, closed, metaOf, attributionOf, onReopen, onCreate }: {
  space: Space; scope: SpaceScope; closed: readonly Panel[];
  metaOf: (panel: Panel) => PanelMeta;
  attributionOf: (panel: Panel) => string | null;
  onReopen: (id: string) => void; onCreate: (kind: PanelCreationKind) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto p-6">
      <div className="w-full max-w-sm">
        <div className="mb-5 text-center">
          <h2 className="text-base font-medium">Open a panel</h2>
          <p className="mt-1 text-sm text-muted-foreground">Work beside the room without leaving the conversation.</p>
        </div>
        <div className="space-y-2">
          <EmptyPanelChoice
            icon={<Globe />}
            title="Web page"
            description="Open a site on this device."
            onClick={() => onCreate('web')}
          />
          {/* Side chats in a synced room need the server to write them, which it does not yet. */}
          {scope === 'local' && (
            <EmptyPanelChoice
              icon={<ChatPlus />}
              title="Side chat"
              description="Start a public or private conversation."
              onClick={() => onCreate('chat')}
            />
          )}
        </div>
        {closed.length > 0 && (
          <div className="mt-6">
            <h3 className="mb-2 px-1 text-xs font-medium text-muted-foreground">In this room</h3>
            <ul className="space-y-1">
              {closed.map(panel => {
                const chat = panel.chatId ? space.chats.find(candidate => candidate.id === panel.chatId) : undefined;
                const meta = metaOf(panel);
                const attribution = attributionOf(panel);
                return (
                  <li key={panel.id}>
                    <button
                      type="button"
                      onClick={() => onReopen(panel.id)}
                      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60"
                    >
                      <PanelIcon panel={panel} chatKind={chat?.kind} meta={meta} className="size-4 text-muted-foreground" />
                      <span className={cn('truncate', panel.scope === 'local' && 'italic')}>{panelTitle(panel, chat?.name, meta)}</span>
                      {attribution && <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">{attribution}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyPanelChoice({ icon, title, description, onClick }: {
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

function PanelTab({ panel, space, meta, attribution, selected, onSelect, onClose }: {
  panel: Panel; space: Space; meta: PanelMeta; attribution: string | null; selected: boolean; onSelect: () => void; onClose: () => void;
}) {
  const chat = panel.chatId ? space.chats.find(candidate => candidate.id === panel.chatId) : undefined;
  const title = panelTitle(panel, chat?.name, meta);

  return (
    <div
      className={cn(
        'group/tab flex h-7 max-w-48 min-w-0 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2 text-sm transition-colors',
        selected
          ? 'bg-muted/50 text-foreground'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
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
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={onClose}
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted',
          selected ? 'opacity-70' : 'opacity-0 group-hover/tab:opacity-70',
        )}
      >
        <MultipleCrossCancelDefault className="size-3" />
      </button>
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
