// The sidebar: one column, three regions — who you are working as, what there
// is to work in, and who you are.
//
// It replaces two columns. A 64px icon rail of workspaces sat beside a 224px
// list of channels, which spent 288px of a 1000px window on navigation and made
// "which workspace am I in" a thing you read from an avatar. The switchers are
// rows now, and the directory gets the whole column.
//
// The workspace switcher is in the HEADER and the account switcher in the
// FOOTER, so the directory between them is the only part that scrolls — the two
// things you need to be able to reach without hunting stay put no matter how
// many spaces you are in.
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { useAnnounceSidebar } from './use-sidebar-presence';
import { AccountSwitcher } from './AccountSwitcher';
import { SpaceDirectory } from '@/features/chat/SpaceDirectory';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarHeader,
} from '@/components/ui/sidebar';

export function AppSidebar() {
  // The top bar holds the toggle and sits above this tree, so it cannot see
  // whether there is anything to toggle. This is how it finds out.
  useAnnounceSidebar();

  return (
    // THE PANEL IS `fixed inset-y-0 h-svh` inside the component, pinned to the
    // VIEWPORT rather than to its parent — so without this it slides under the
    // top bar, which owns the first 40px of the window. `className` lands on
    // that panel, and tailwind-merge resolves the later `top`/`h` against the
    // component's own `inset-y-0 h-svh`.
    <Sidebar className="top-10 h-[calc(100svh-2.5rem)] border-border/60">
      <SidebarHeader className="border-b border-border/60">
        <WorkspaceSwitcher />
      </SidebarHeader>

      <SidebarContent>
        <SpaceDirectory />
      </SidebarContent>

      <SidebarFooter className="border-t border-border/60">
        <AccountSwitcher />
      </SidebarFooter>
    </Sidebar>
  );
}
