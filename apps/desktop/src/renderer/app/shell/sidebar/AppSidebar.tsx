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
// import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '../../state';
// import { useDialKit, type DialConfig } from 'dialkit';
import { SearchDefault, UserTwo } from '@relayed/icons';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { useAnnounceSidebar } from './use-sidebar-presence';
import { AccountSwitcher } from './AccountSwitcher';
import { SpaceDirectory } from '@/features/chat/SpaceDirectory';
import { LocalRoomsDirectory } from '@/features/local-rooms/LocalRoomsDirectory';
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

/**
 * Destinations that exist. A row here is a promise that clicking it goes
 * somewhere, so nothing is listed ahead of the screen it would open.
 * Workspace-tier, so absent while no workspace is open.
 */
const destinationsFor = (wsId: string | null) => wsId === null ? [] : [
  { label: 'People', icon: UserTwo, to: `/w/${wsId}/people` },
];

/* DialKit is temporarily disabled. Keep the controls beside their consumer so
 * restoring the design-tuning surface is a small, reviewable change.
const SIDEBAR_ITEM_CONTROLS = {
  backgroundToken: {
    type: 'select',
    options: [
      { label: 'Background', value: 'var(--background)' },
      { label: 'Card', value: 'var(--card)' },
      { label: 'Primary', value: 'var(--primary)' },
      { label: 'Secondary', value: 'var(--secondary)' },
      { label: 'Muted', value: 'var(--muted)' },
      { label: 'Accent', value: 'var(--accent)' },
      { label: 'Sidebar', value: 'var(--sidebar)' },
      { label: 'Sidebar primary', value: 'var(--sidebar-primary)' },
      { label: 'Sidebar accent', value: 'var(--sidebar-accent)' },
      { label: 'Outgoing message', value: 'var(--message-outgoing)' },
      { label: 'Destructive', value: 'var(--destructive)' },
    ],
    default: 'var(--primary)',
  },
  backgroundOpacity: [0.1, 0, 1, 0.05],
  textToken: {
    type: 'select',
    options: [
      { label: 'Foreground', value: 'var(--foreground)' },
      { label: 'Primary foreground', value: 'var(--primary-foreground)' },
      { label: 'Secondary foreground', value: 'var(--secondary-foreground)' },
      { label: 'Muted foreground', value: 'var(--muted-foreground)' },
      { label: 'Accent foreground', value: 'var(--accent-foreground)' },
      { label: 'Sidebar foreground', value: 'var(--sidebar-foreground)' },
      { label: 'Sidebar primary foreground', value: 'var(--sidebar-primary-foreground)' },
      { label: 'Sidebar accent foreground', value: 'var(--sidebar-accent-foreground)' },
      { label: 'Outgoing message foreground', value: 'var(--message-outgoing-foreground)' },
      { label: 'Destructive', value: 'var(--destructive)' },
    ],
    default: 'var(--muted-foreground)',
  },
  textOpacity: [1, 0, 1, 0.05],
} satisfies DialConfig;
*/

export function AppSidebar({ inline = false }: { inline?: boolean }) {
  const { open } = useSidebar();
  // From state, not the URL: a local room's route has no workspace in its path.
  const wsId = useSession().state.workspaceId;
  const navigate = useNavigate();
  const destinations = destinationsFor(wsId);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  /* DialKit is temporarily disabled.
  const itemTokens = useDialKit('Sidebar items', SIDEBAR_ITEM_CONTROLS, {
    persist: true,
  });
  const itemStyles = {
    '--sidebar-item-background': withOpacity(
      itemTokens.backgroundToken,
      itemTokens.backgroundOpacity,
    ),
    '--sidebar-item-foreground': withOpacity(
      itemTokens.textToken,
      itemTokens.textOpacity,
    ),
  } as CSSProperties;
  */

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
    // DialKit previously supplied `style={itemStyles}` here.
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

        {destinations.length > 0 && (
          <SidebarMenu className="gap-0.5">
            {destinations.map(destination => (
              <SidebarItem
                key={destination.label}
                label={destination.label}
                icon={destination.icon}
                to={destination.to}
              />
            ))}
          </SidebarMenu>
        )}
      </SidebarHeader>

      <SidebarContent className="border-t border-sidebar-border/40 pt-1">
        <LocalRoomsDirectory />
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
            <CommandGroup heading="Go to">
              {destinations.map(destination => {
                const Icon = destination.icon;
                return (
                  <CommandItem
                    key={destination.label}
                    value={destination.label}
                    onSelect={() => {
                      setCommandPaletteOpen(false);
                      void navigate(destination.to);
                    }}
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

/* DialKit is temporarily disabled.
function withOpacity(token: string, opacity: number): string {
  return `color-mix(in oklch, ${token} ${opacity * 100}%, transparent)`;
}
*/
