// The command menu: one place to find somewhere to go or something to do.
//
// Owns `app.search.open` rather than AppSidebar owning it with its own window
// listener. Settings replaces AppSidebar with SettingsSidebar, so Mod+K
// disappeared exactly where a person might go to look it up. Mounted beside the
// top bar, its lifetime is the window's.
//
// The menu knows nothing of what it lists. Each source is a component that
// reads what it needs, reports its own loading, and renders rows through
// CommandMenuRow; cmdk filters and ranks across all of them. A source also
// declares the sections it can fill, which is all the tab strip needs. A new
// kind of result is a new entry in SOURCES, not an edit here.
import {
  useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent,
} from 'react';
import { useSession } from '@/app/state';
import {
  Command, CommandDialog, CommandEmpty, CommandInput, CommandList,
} from '@/components/ui/command';
import { useCommandHandler } from '@/lib/commands/CommandProvider';
import {
  CommandMenuContext, CommandMenuSectionContext,
  type CommandMenuApi, type CommandMenuSection,
} from './command-menu-context.ts';
import { CommandMenuTabs } from './CommandMenuTabs.tsx';
import { rankKeywords } from './rank/rank.ts';
import { ACTION_SECTIONS, ActionSource } from './sources/ActionSource.tsx';
import { NAVIGATION_SECTIONS, NavigationSource } from './sources/navigation/NavigationSource.tsx';

/** In the order their groups are listed, and their tabs offered, before anything is typed. */
const SOURCES: readonly { Source: ComponentType; sections: readonly CommandMenuSection[] }[] = [
  { Source: NavigationSource, sections: NAVIGATION_SECTIONS },
  { Source: ActionSource, sections: ACTION_SECTIONS },
];

const SECTIONS: readonly CommandMenuSection[] = SOURCES.flatMap(source => source.sections);

export function CommandMenu() {
  // From state, not the URL: a local room's route has no workspace in its path.
  const workspaceId = useSession().state.workspaceId;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Null is "All". A section stays chosen while you type: narrowing first and
  // then searching within it is the point of the strip.
  const [section, setSection] = useState<string | null>(null);
  const [filled, setFilled] = useState<ReadonlySet<string>>(() => new Set());
  const pending = useRef<(() => void) | null>(null);

  // Everything it lists today sits behind the sidebar, which needs a workspace.
  useCommandHandler('app.search.open', { layer: 'application', enabled: workspaceId !== null, run: () => setOpen(true) });

  useEffect(() => {
    if (workspaceId === null) setOpen(false);
  }, [workspaceId]);

  const reportRows = useCallback((id: string, hasRows: boolean) => {
    setFilled(previous => {
      if (previous.has(id) === hasRows) return previous;
      const next = new Set(previous);
      if (hasRows) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const api = useMemo<CommandMenuApi>(() => ({
    run: perform => {
      pending.current = perform;
      setOpen(false);
    },
    reportRows,
  }), [reportRows]);

  const tabs = useMemo(() => SECTIONS.filter(entry => filled.has(entry.id)), [filled]);

  // The strip's own keys. Left and right belong to the caret in the input, so
  // Tab walks the tabs; nothing else in the popup wants it.
  const onInputKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || tabs.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const order: (string | null)[] = [null, ...tabs.map(entry => entry.id)];
    const here = order.indexOf(section);
    const step = event.shiftKey ? -1 : 1;
    setSection(order[(here + step + order.length) % order.length] ?? null);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={next => {
        if (next) return;
        setSearch('');
        setSection(null);
        const perform = pending.current;
        pending.current = null;
        // This fires as the popup unmounts, and base-ui returns focus in a
        // microtask after that. A task later, an action that moves focus (a new
        // panel tab's address bar) keeps it.
        if (perform) setTimeout(perform, 0);
      }}
      size="lg"
      title="Command menu"
      description="Go to a room, channel, person or page, or run an action"
    >
      {/* The popup unmounts its children once closed, so sources read only while it is open. */}
      <CommandMenuContext.Provider value={api}>
        <CommandMenuSectionContext.Provider value={section}>
          <Command filter={(_value, typed, keywords) => rankKeywords(typed, keywords ?? [])}>
            <CommandInput
              autoFocus
              placeholder="Search or run a command…"
              value={search}
              onValueChange={setSearch}
              onKeyDown={onInputKeyDown}
            />
            <CommandMenuTabs sections={tabs} active={section} onSelect={setSection} />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              {SOURCES.map(({ Source }, index) => <Source key={index} />)}
            </CommandList>
          </Command>
        </CommandMenuSectionContext.Provider>
      </CommandMenuContext.Provider>
    </CommandDialog>
  );
}
