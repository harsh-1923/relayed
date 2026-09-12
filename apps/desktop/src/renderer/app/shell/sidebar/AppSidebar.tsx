// The sidebar: one column, three regions — who you are working as, what there
// is to work in, and who you are.
//
// It replaces two columns. A 64px icon rail of workspaces sat beside a 224px
// list of channels, which spent 288px of a 1000px window on navigation and made
// "which workspace am I in" a thing you read from an avatar. The switchers are
// rows now, and the directory gets the whole column.
//
// The workspace switcher, search and primary destinations are in the HEADER,
// and the account switcher is in the FOOTER. The directory between them is the
// only part that scrolls, so the things you reach most often never disappear
// behind a long list of spaces.
import { useEffect, useState } from 'react';
import {
  Activity, ChatChatting, MagneticCompass, PencilEditBox, SearchDefault, UserTwo,
} from '@relayed/icons';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { useAnnounceSidebar } from './use-sidebar-presence';
import { AccountSwitcher } from './AccountSwitcher';
import { SpaceDirectory } from '@/features/chat/SpaceDirectory';
import { SidebarItem } from '@/components/SidebarItem';
import { Button } from '@/components/ui/button';
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput,
  CommandItem, CommandList,
} from '@/components/ui/command';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

const PRIMARY_DESTINATIONS = [
  { label: 'New space', icon: PencilEditBox },
  { label: 'Activity', icon: Activity },
  { label: 'Threads', icon: ChatChatting },
  { label: 'People', icon: UserTwo },
  { label: 'Explore', icon: MagneticCompass },
] as const;

export function AppSidebar({ inline = false }: { inline?: boolean }) {
  const { open } = useSidebar();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // The top bar holds the toggle and sits above this tree, so it cannot see
  // whether there is anything to toggle. This is how it finds out.
  useAnnounceSidebar();

  useEffect(() => {
    function handleCommandPaletteShortcut(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'k' || (!event.metaKey && !event.ctrlKey)) {
        return;
      }

      event.preventDefault();
      setCommandPaletteOpen(true);
    }

    window.addEventListener('keydown', handleCommandPaletteShortcut);
    return () => window.removeEventListener('keydown', handleCommandPaletteShortcut);
  }, []);

  return (
    // Desktop is inline because the resizable panel owns its width. Mobile is
    // still shadcn's off-canvas Sheet; Sidebar offsets it below the 40px title
    // bar so the same top-level controls remain visible while it is open.
    <Sidebar
      collapsible={inline ? 'none' : 'offcanvas'}
      className={cn(
        inline && 'h-full w-full bg-window-glass',
        inline && !open && 'invisible',
      )}
    >
      <SidebarHeader className="gap-3 pb-3">
        <div className="flex min-w-0 items-center gap-1">
          <WorkspaceSwitcher />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Search"
            aria-keyshortcuts="Meta+K Control+K"
            title="Search (Command K)"
            onClick={() => setCommandPaletteOpen(true)}
            className="size-6 text-muted-foreground hover:text-foreground"
          >
            <SearchDefault className="size-4" />
          </Button>
        </div>

        <SidebarMenu className="gap-0.5">
          {PRIMARY_DESTINATIONS.map(destination => {
            return (
              <SidebarItem
                key={destination.label}
                label={destination.label}
                icon={destination.icon}
              />
            );
          })}
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="border-t border-sidebar-border/40 pt-1">
        <SpaceDirectory />
      </SidebarContent>

      <SidebarFooter className="border-t border-border/40">
        <AccountSwitcher />
      </SidebarFooter>

      <CommandDialog
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        title="Search Relayed"
        description="Search for a space, person or action"
      >
        <Command>
          <CommandInput autoFocus placeholder="Search Relayed…" />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup heading="Quick actions">
              {PRIMARY_DESTINATIONS.map(destination => {
                const Icon = destination.icon;
                return (
                  <CommandItem
                    key={destination.label}
                    value={destination.label}
                    onSelect={() => setCommandPaletteOpen(false)}
                  >
                    <Icon />
                    <span>{destination.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </Sidebar>
  );
}
