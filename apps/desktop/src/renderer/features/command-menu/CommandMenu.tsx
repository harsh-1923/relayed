// The command menu: one place to find somewhere to go or something to do.
//
// Owns `app.search.open` rather than AppSidebar owning it with its own window
// listener. Settings replaces AppSidebar with SettingsSidebar, so Mod+K
// disappeared exactly where a person might go to look it up. Mounted beside the
// top bar, its lifetime is the window's.
//
// The menu knows nothing of what it lists. Each source is a component that
// reads what it needs, reports its own loading, and renders rows through
// CommandMenuRow; cmdk filters and ranks across all of them. A new kind of
// result is a new entry in SOURCES, not an edit here.
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useSession } from '@/app/state';
import {
  Command, CommandDialog, CommandEmpty, CommandInput, CommandList,
} from '@/components/ui/command';
import { useCommandHandler } from '@/lib/commands/CommandProvider';
import { CommandMenuContext, type CommandMenuApi } from './command-menu-context.ts';
import { rankKeywords } from './rank/rank.ts';
import { ActionSource } from './sources/ActionSource.tsx';
import { NavigationSource } from './sources/navigation/NavigationSource.tsx';

/** In the order their groups are listed before anything is typed. */
const SOURCES: readonly ComponentType[] = [NavigationSource, ActionSource];

export function CommandMenu() {
  // From state, not the URL: a local room's route has no workspace in its path.
  const workspaceId = useSession().state.workspaceId;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const pending = useRef<(() => void) | null>(null);

  // Everything it lists today sits behind the sidebar, which needs a workspace.
  useCommandHandler('app.search.open', { layer: 'application', enabled: workspaceId !== null, run: () => setOpen(true) });

  useEffect(() => {
    if (workspaceId === null) setOpen(false);
  }, [workspaceId]);

  const api = useMemo<CommandMenuApi>(() => ({
    run: perform => {
      pending.current = perform;
      setOpen(false);
    },
  }), []);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={next => {
        if (next) return;
        setSearch('');
        const perform = pending.current;
        pending.current = null;
        // This fires as the popup unmounts, and base-ui returns focus in a
        // microtask after that. A task later, an action that moves focus (a new
        // panel tab's address bar) keeps it.
        if (perform) setTimeout(perform, 0);
      }}
      title="Command menu"
      description="Go to a room, channel, person or page, or run an action"
    >
      {/* The popup unmounts its children once closed, so sources read only while it is open. */}
      <CommandMenuContext.Provider value={api}>
        <Command filter={(_value, typed, keywords) => rankKeywords(typed, keywords ?? [])}>
          <CommandInput
            autoFocus
            placeholder="Search or run a command…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            {SOURCES.map((Source, index) => <Source key={index} />)}
          </CommandList>
        </Command>
      </CommandMenuContext.Provider>
    </CommandDialog>
  );
}
