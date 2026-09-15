// Account- and device-level settings replace the workspace directory while
// keeping the same shell. The route decides which directory is visible; the
// resizable panel, mobile Sheet and title-bar toggle remain one mechanism.
import { Link, useLocation } from 'react-router';
import {
  ArrowLeft, Bot, ColorPalette, FilterHorizontal, Globe, KeyboardWired, NotificationBellOn, Tools,
} from '@relayed/icons';
import { AccountSwitcher } from './AccountSwitcher';
import { useAnnounceSidebar } from './use-sidebar-presence';
import { useSession } from '../../state';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

const SETTINGS_NAVIGATION = [
  { to: '/settings/general', label: 'General', icon: FilterHorizontal },
  { to: '/settings/appearance', label: 'Appearance', icon: ColorPalette },
  { to: '/settings/agent', label: 'Claude Agent', icon: Bot },
  { to: '/settings/notifications', label: 'Notifications', icon: NotificationBellOn },
  { to: '/settings/shortcuts', label: 'Keyboard shortcuts', icon: KeyboardWired },
  { to: '/settings/browsers', label: 'Browser sign-ins', icon: Globe },
  { to: '/settings/advanced', label: 'Advanced', icon: Tools },
] as const;

export function SettingsSidebar({ inline = false }: { inline?: boolean }) {
  const { state } = useSession();
  const { pathname } = useLocation();
  const { open } = useSidebar();
  const workspace = state.workspaces.find(
    candidate => candidate.workspaceId === state.workspaceId,
  );
  const returnTo = workspace ? `/w/${workspace.workspaceId}` : '/account';

  useAnnounceSidebar();

  return (
    <Sidebar
      collapsible={inline ? 'none' : 'offcanvas'}
      className={cn(
        inline && 'h-full w-full bg-window-glass',
        inline && !open && 'invisible',
      )}
    >
      <SidebarHeader className="border-b border-border/60">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link to={returnTo} />}
              className="gap-2"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-lg border bg-background/70">
                <ArrowLeft className="size-4" />
              </span>
              <div className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">Settings</span>
                <span className="truncate text-xs text-muted-foreground">
                  {workspace ? `Back to ${workspace.name}` : 'Back to account'}
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Settings</SidebarGroupLabel>
          <SidebarMenu>
            {SETTINGS_NAVIGATION.map(item => (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton
                  render={<Link to={item.to} />}
                  isActive={pathname === item.to}
                >
                  <item.icon className="text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-border/40">
        <AccountSwitcher />
      </SidebarFooter>
    </Sidebar>
  );
}
