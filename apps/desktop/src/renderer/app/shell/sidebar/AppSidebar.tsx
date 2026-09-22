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
import { useSession } from '../../state';
import { SearchDefault } from '@relayed/icons';
import { iconForDestination } from '@/lib/navigation/destinations/destination-icon.ts';
import { primaryDestinationsFor } from '@/lib/navigation/destinations/destinations.ts';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { useAnnounceSidebar } from './use-sidebar-presence';
import { AccountSwitcher } from './AccountSwitcher';
import { SpaceDirectory } from '@/features/chat/SpaceDirectory';
import { LocalRoomsDirectory } from '@/features/local-rooms/LocalRoomsDirectory';
import { SidebarItem } from '@/components/SidebarItem';
import { EyeAvatar } from '@relayed/avatars/react';
import { Button } from '@/components/ui/button';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, useSidebar,
} from '@/components/ui/sidebar';
import { useCommand } from '@/lib/commands/CommandProvider';
import { cn } from '@/lib/utils';

// The playground's own icon is one of the avatars it generates — the row shows
// the thing it links to, and blinks at you from 16px, which is the size the
// experiment actually has to survive. Module scope, so it is not a fresh
// component type on every sidebar render.
function PlaygroundIcon({ className }: { className?: string }) {
  return <EyeAvatar seed="playground" mood="curious" className={className} />;
}

export function AppSidebar({ inline = false }: { inline?: boolean }) {
  const { open } = useSidebar();
  // From state, not the URL: a local room's route has no workspace in its path.
  const wsId = useSession().state.workspaceId;
  const destinations = primaryDestinationsFor(wsId);
  const search = useCommand('app.search.open');

  // The top bar holds the toggle and sits above this tree, so it cannot see
  // whether there is anything to toggle. This is how it finds out.
  useAnnounceSidebar();

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
            aria-keyshortcuts={search.enabled ? search.ariaKeyShortcuts : undefined}
            title={search.shortcutLabel ? `Search (${search.shortcutLabel})` : 'Search'}
            disabled={!search.enabled}
            onClick={() => search.execute()}
            className="size-6 text-muted-foreground hover:text-foreground"
          >
            <SearchDefault className="size-4" />
          </Button>
        </div>

        {destinations.length > 0 && (
          <SidebarMenu className="gap-0.5">
            {destinations.map(destination => (
              <SidebarItem
                key={destination.id}
                label={destination.label}
                icon={iconForDestination(destination)}
                to={destination.to}
                disabled={destination.disabled}
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
        {/* A bench, not a destination. Deliberately NOT in `primaryDestinationsFor`:
            that list is the shared navigation vocabulary the command menu and search
            also read, and a tuning surface does not belong in it. */}
        <SidebarMenu className="gap-0.5">
          <SidebarItem label="Avatar playground" icon={PlaygroundIcon} to="/playground/avatars" />
        </SidebarMenu>
        <AccountSwitcher />
      </SidebarFooter>
    </Sidebar>
  );
}
