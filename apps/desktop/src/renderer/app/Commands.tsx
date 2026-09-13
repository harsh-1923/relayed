// Mounts the command bus for the window, with the host platform the session
// already holds (SHORTCUTS.md §6.2). Inside AppStateProvider for that fact, and
// above SidebarProvider, TopBar and the route tree so no command's lifetime
// depends on which sidebar or route is showing.
//
// It also feeds the bus the person's stored bindings. They are ordinary
// preference rows on the ordinary live read, so a write in another window or a
// reset repaints every shortcut here with no second state mechanism
// (PREFERENCES.md §8).
import { useMemo, type ReactNode } from 'react';
import { KEYBINDING_PREFIX } from '../../shared/prefs.ts';
import { CommandProvider } from '@/lib/commands/CommandProvider';
import { useQuery } from '@/lib/query';
import { useSession } from './state';

export function Commands({ children }: { children: ReactNode }) {
  const { state } = useSession();
  const { rows } = useQuery('prefs.list');
  const overrides = useMemo(() => {
    const byCommand = new Map<string, unknown>();
    for (const row of rows ?? []) {
      if (!row.key.startsWith(KEYBINDING_PREFIX)) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(row.value);
      } catch {
        // Unparseable JSON still counts as a row: the resolver reports it as
        // unreadable and uses the default, rather than treating it as absent.
        raw = undefined;
      }
      byCommand.set(row.key.slice(KEYBINDING_PREFIX.length), raw);
    }
    return byCommand;
  }, [rows]);

  return <CommandProvider platform={state.platform} overrides={overrides}>{children}</CommandProvider>;
}
