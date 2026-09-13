// The panel container: every open panel as a tab, and the one shown beneath
// them (PANELS.md §10). One panel is shown at a time; opening another adds a
// tab rather than splitting the pane again.
//
// A type this build does not know is kept and drawn as a placeholder, never
// dropped: a newer version wrote it (§3.3). A body that throws is caught here,
// so one broken panel does not take the container or the chat with it.
import { Component, type ComponentType, type ReactNode } from 'react';
import { ChatDefault, Globe, LockClose, MultipleCrossCancelDefault, UploadUp } from '@relayed/icons';
import type { Panel, Space, SpaceScope } from '../../../preload/api';
import { Button } from '@/components/ui/button';
import { ChatView } from '@/features/chat/ChatView';
import { call } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import type { OpenPanels } from './useOpenPanels';

interface PanelBodyProps { panel: Panel; space: Space; scope: SpaceScope }

const PANEL_BODIES: Partial<Record<string, ComponentType<PanelBodyProps>>> = {
  chat: ({ panel, space, scope }) => (panel.chatId ? <ChatView spaceId={space.id} chatId={panel.chatId} scope={scope} /> : null),
  web: WebPanelBody,
};

export function PanelContainer({ tabs, space, scope, openPanels }: {
  tabs: readonly Panel[]; space: Space; scope: SpaceScope; openPanels: OpenPanels;
}) {
  const shown = tabs.find(panel => panel.id === openPanels.active) ?? tabs.at(-1);
  if (!shown) return null;
  const Body = PANEL_BODIES[shown.type] ?? UnknownPanelBody;

  const share = () => { void call(api => api.query('local.panels.share', { panelId: shown.id })); };
  const remove = () => {
    void call(api => api.query('local.panels.remove', { panelId: shown.id })).then(() => openPanels.close(shown.id));
  };

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label="Panels">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <div role="tablist" aria-label="Open panels" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map(panel => (
            <PanelTab
              key={panel.id}
              panel={panel}
              space={space}
              selected={panel.id === shown.id}
              onSelect={() => openPanels.select(panel.id)}
              onClose={() => openPanels.close(panel.id)}
            />
          ))}
        </div>
        {shown.scope === 'local' && (
          <Button variant="ghost" size="icon-xs" title="Only on this device. Share it to the room." aria-label="Share to the room" onClick={share}>
            <UploadUp />
          </Button>
        )}
        {shown.type !== 'chat' && (
          <Button variant="ghost" size="xs" title="Remove from the room" onClick={remove}>Remove</Button>
        )}
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        {/* Keyed, so a tab switch starts the next panel fresh rather than reusing the last one's state. */}
        <PanelBoundary key={shown.id}>
          <Body panel={shown} space={space} scope={scope} />
        </PanelBoundary>
      </div>
    </section>
  );
}

function PanelTab({ panel, space, selected, onSelect, onClose }: {
  panel: Panel; space: Space; selected: boolean; onSelect: () => void; onClose: () => void;
}) {
  const chat = panel.chatId ? space.chats.find(candidate => candidate.id === panel.chatId) : undefined;
  const Icon = panel.type === 'chat' ? (chat?.kind === 'private' ? LockClose : ChatDefault) : Globe;
  const title = panelTitle(panel, chat?.name);

  return (
    <div
      className={cn(
        'group/tab flex h-7 max-w-48 min-w-0 shrink-0 items-center gap-1.5 rounded-md border pr-1 pl-2 text-xs transition-colors',
        selected
          ? 'border-border bg-background text-foreground shadow-xs'
          : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        title={panel.scope === 'local' ? `${title} — only on this device` : title}
        onClick={onSelect}
        onAuxClick={event => { if (event.button === 1) onClose(); }}
        className="flex min-w-0 flex-1 items-center gap-1.5 outline-none"
      >
        <Icon className="size-3.5 shrink-0" />
        <span className={cn('truncate', panel.scope === 'local' && 'italic')}>{title}</span>
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

/** What a panel is called: its chat's name, its own title, or where a page points. */
export function panelTitle(panel: Panel, chatName: string | null | undefined): string {
  if (panel.type === 'chat') return chatName ?? panel.title ?? 'Chat';
  if (panel.title) return panel.title;
  const url = typeof panel.payload['url'] === 'string' ? panel.payload['url'] : null;
  if (url) {
    try { return new URL(url).host; } catch { return url; }
  }
  return panel.type;
}

/**
 * A web page. Drawn by a native view once the overlay spike settles how
 * (LOCAL-ROOMS.md §10.4, PANELS.md §12.1); until then it says where it points.
 */
function WebPanelBody({ panel }: PanelBodyProps) {
  const url = typeof panel.payload['url'] === 'string' ? panel.payload['url'] : '';
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <Globe className="size-6 text-muted-foreground" />
      <p className="max-w-full truncate text-sm font-medium select-text" title={url}>{url}</p>
      <p className="text-xs text-muted-foreground">Web pages are not drawn inside panels yet.</p>
    </div>
  );
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
