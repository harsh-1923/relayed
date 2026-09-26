// Which workspace you are in, and how you get to another one.
//
// Was a 64px rail of icons. The rail's information is not lost, but it is no
// longer free: a column of avatars showed every workspace's mention count and
// parked writes at a glance, and a single row can only show the one you are in.
// So the trigger carries an AGGREGATE of everywhere else — "3 elsewhere" — and
// the menu carries the breakdown. A hint that is only visible after a click is
// a hint that arrives after you needed it.
//
// IT NAVIGATES. It does not call `workspace.switch` — that is invariant 56, and
// it is the whole reason the workspace can live in the URL without two things
// owning which one is active (FRONTEND.md §4.5). The gate downstream turns the
// URL into a switch.
//
// Drawn entirely from account.db, so it is correct on a cold boot with no
// network and before any authentication (STORAGE.md §6, §11).
//
// GROUPED BY ORGANIZATION (ORG-DOMAINS.md). An org can hold several
// workspaces. Managing or browsing an org is NOT here: it is a sidebar row
// inside a workspace, so the workspace stays open while its org is looked at.
// The one live question, "is there anywhere new I could join", is asked when
// the menu opens and never blocks drawing it.
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ChevronDown, PlusDefault } from '@relayed/icons';
import type { WorkspaceRow } from '../../../../preload/api';
import { useSession } from '../../state';
import { blobSrc, call, hueFor, initials } from '@/lib/ipc';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar';

/**
 * Highlight what the URL asks for, not what the engine has finished opening.
 * A switch resolves in milliseconds but not instantly, and highlighting the
 * engine's answer makes the click feel like it was ignored.
 */
const routedWorkspace = (pathname: string): string | null =>
  /^\/w\/([^/]+)/.exec(pathname)?.[1] ?? null;

export function WorkspaceSwitcher() {
  const { state } = useSession();
  const routed = routedWorkspace(useLocation().pathname);
  const workspaces = state.workspaces.filter(w => w.state === 'active');
  const current = workspaces.find(w => w.workspaceId === routed) ?? workspaces[0];
  const [joinable, setJoinable] = useState(0);

  if (!current) return null;

  const orgs = [...new Map(workspaces.map(w => [w.orgId, w])).values()].map(first => ({
    orgId: first.orgId,
    name: first.orgName,
    workspaces: workspaces.filter(w => w.orgId === first.orgId),
  }));

  const lookForJoins = (open: boolean) => {
    if (!open) return;
    void call(api => api.query('org.matches'))
      .then(v => setJoinable(v ? v.pendingJoins.length + v.orgMatches.length : 0))
      .catch(() => {});
  };

  const elsewhere = workspaces
    .filter(w => w.workspaceId !== current.workspaceId)
    .reduce((sum, w) => sum + w.mentionHint, 0);
  const parked = workspaces
    .filter(w => w.workspaceId !== current.workspaceId)
    .reduce((sum, w) => sum + w.outboxHint, 0);

  return (
    <SidebarMenu className="min-w-0 flex-1">
      <SidebarMenuItem>
        <DropdownMenu onOpenChange={lookForJoins}>
          <DropdownMenuTrigger
            render={(
              // Shrinks with the row, never wider than it: a long name
              // truncates rather than pushing Search off the header.
              <SidebarMenuButton
                className="w-auto max-w-full min-w-0 gap-2 px-2 text-base font-medium"
              />
            )}
          >
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
              {/* The logo is what makes one workspace recognisable from another
                  at a glance (FILES.md); initials on its colour when it has none. */}
              <Face workspace={current} className="size-5 rounded-md" />
              <span className="truncate">{current.name}</span>
              <ChevronDown className="size-4 shrink-0 opacity-50" />
            </div>
            {elsewhere > 0 && (
              <span title={`${elsewhere} elsewhere`}
                    className="grid size-4 shrink-0 place-items-center rounded-full
                               bg-destructive text-[10px] text-white">
                {elsewhere > 9 ? '9+' : elsewhere}
              </span>
            )}
            {/* Writes parked in another workspace while this one is open
                (STORAGE.md §15.2). Not an error, and not nothing. */}
            {parked > 0 && elsewhere === 0 && (
              <span title={`${parked} unsent elsewhere`}
                    className="size-2 shrink-0 rounded-full bg-amber-500" />
            )}
          </DropdownMenuTrigger>

          <DropdownMenuContent align="start" side="bottom" sideOffset={4}
                               className="min-w-0 max-w-(--available-width) space-y-2"
                               style={{
                                 width: 'calc(var(--workspace-sidebar-width, var(--sidebar-width)) - 1rem)',
                               }}>
            {orgs.map(org => (
              <DropdownMenuGroup key={org.orgId} className="space-y-1.5">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {org.name}
                </DropdownMenuLabel>
                {org.workspaces.map(workspace => (
                  <DropdownMenuItem
                    key={workspace.workspaceId}
                    render={<Link to={`/w/${workspace.workspaceId}`} />}
                    className="gap-2 rounded-lg"
                  >
                    <Face workspace={workspace} className="size-5.5 rounded-md" />
                    <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                    {workspace.mentionHint > 0 && (
                      <span className="grid size-4 place-items-center rounded-full
                                       bg-destructive text-[10px] text-white">
                        {workspace.mentionHint > 9 ? '9+' : workspace.mentionHint}
                      </span>
                    )}
                    {workspace.outboxHint > 0 && (
                      <span title={`${workspace.outboxHint} unsent`}
                            className="size-2 rounded-full bg-amber-500" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ))}

            <DropdownMenuSeparator />

            {joinable > 0 && (
              <DropdownMenuItem render={<Link to="/onboarding/join" />} className="gap-2 mt-1">
                <span className="grid size-6 place-items-center rounded-md bg-primary text-[11px]
                                 font-medium text-primary-foreground">
                  {joinable > 9 ? '9+' : joinable}
                </span>
                <span className="font-medium">Join your team</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem render={<Link to="/onboarding/create" />} className="gap-2 mt-1">
              <div className="grid size-6 place-items-center rounded-md border bg-background">
                <PlusDefault className="size-3.5" />
              </div>
              <span className="font-medium text-muted-foreground">New organization</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/**
 * The WORKSPACE's face, never the member's — the field names make that hard to
 * get wrong now (invariant 47). A workspace image is optional and usually
 * absent; initials on a derived colour are the fallback, and a good one.
 */
function Face({ workspace, className }: { workspace: WorkspaceRow; className: string }) {
  const src = blobSrc(workspace.workspaceAvatarBlob);
  return (
    <div
      className={`grid shrink-0 place-items-center overflow-hidden text-xs
                  font-medium text-foreground/90 ${className}`}
      style={src ? undefined
                 : { backgroundColor: `oklch(0.34 0.07 ${hueFor(workspace.workspaceId)})` }}
    >
      {src
        ? <img src={src} alt="" className="size-full object-cover" />
        : <small>{initials(workspace.name)}</small>}
    </div>
  );
}
