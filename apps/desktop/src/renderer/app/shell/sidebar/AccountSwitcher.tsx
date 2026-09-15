// You, at the foot of the sidebar: who you are in this workspace, and the
// account-tier things that are not about this workspace at all.
//
// NOT YET A SWITCHER, and named for what it is rather than for the drawing.
// `account.db` knows about several accounts — `state.accounts` lists them — but
// there is no engine operation that makes a different one active, so offering a
// choice here would be a menu that cannot do the thing it names. It lists the
// others as a fact, with the current one marked, and sends everything else to
// /account.
//
// SIGN-OUT IS NOT HERE either, and that is deliberate rather than an omission.
// It has one authoritative path: the reply to `auth.signOut`, not the push that
// fires partway through it (routes/Account.tsx). A second copy of that
// reasoning in a dropdown is a second place for it to drift.
import { Link, useParams } from 'react-router';
import {
  ChevronSortVertical, ContactsBook, LogOutRight, Settings01, UserTwo, Bot,
} from '@relayed/icons';
import { useSession } from '../../state';
import { blobSrc, initials } from '@/lib/ipc';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar';

export function AccountSwitcher() {
  const { state } = useSession();
  const { wsId } = useParams();
  const me = state.workspaces.find(w => w.workspaceId === (wsId ?? state.workspaceId));

  if (!me) return null;

  const others = state.accounts.filter(a => a.accountId !== state.accountId);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton  className="gap-2 rounded-2xl" />}>
            <Avatar className="size-5">
              <AvatarImage src={blobSrc(me.actorAvatarBlob) ?? undefined} />
              <AvatarFallback className="rounded-lg text-[10px]">
                {initials(me.actorDisplayName)}
              </AvatarFallback>
            </Avatar>
            <div className="grid min-w-0 flex-1 text-left leading-tight">
              <span className="min-w-0 truncate text-sm font-normal text-muted-foreground">{me.actorDisplayName}</span>
              {/*<span className="truncate text-xs text-muted-foreground">@{me.actorHandle}</span>*/}
            </div>
            <ChevronSortVertical className="size-4 shrink-0 opacity-50" />
          </DropdownMenuTrigger>

          <DropdownMenuContent
            align="start"
            side="top"
            sideOffset={4}
            className="w-(--anchor-width) min-w-0"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                In this workspace
              </DropdownMenuLabel>
              <DropdownMenuItem render={<Link to={`/w/${me.workspaceId}/settings/profile`} />}>
                <ContactsBook className="size-4 text-muted-foreground" />
                Your profile
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to={`/w/${me.workspaceId}/people`} />}>
                <UserTwo className="size-4 text-muted-foreground" />
                People
              </DropdownMenuItem>
              {/* Workspace settings has no other door from the shell: ⌘, opens
                  the ACCOUNT settings, which is a different page. */}
              <DropdownMenuItem render={<Link to={`/w/${me.workspaceId}/settings/agents`} />}>
                <Bot className="size-4 text-muted-foreground" />
                Agents
              </DropdownMenuItem>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            {/* Account tier: no workspace replica is open and none is needed
                (STORAGE.md §5). The route sits outside /w/ for that reason. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {others.length > 0 ? `Account · ${others.length} more on this device` : 'Account'}
              </DropdownMenuLabel>
              <DropdownMenuItem render={<Link to="/settings/general" />}>
                <Settings01 className="size-4 text-muted-foreground" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/account" />}>
                <LogOutRight className="size-4 text-muted-foreground" />
                Account and sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
