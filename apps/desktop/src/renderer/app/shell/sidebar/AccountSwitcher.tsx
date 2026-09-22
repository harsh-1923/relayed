// You, at the foot of the sidebar: who you are in this workspace, the accounts
// on this device, and the account-tier things that are not about this
// workspace at all.
//
// SWITCHING ACCOUNTS CALLS `account.switch`, then navigates to the workspace it
// opened — unlike the workspace switcher, which only navigates (invariant 56).
// An account is not in the URL, so there is nothing for a gate to derive it
// from. The two updates land in one render, so WorkspaceGate finds the
// workspace already open rather than briefly unknown.
//
// Another account's WORKSPACES are never shown anywhere, and could not be: the
// engine sends each other account as a label only (STORAGE.md §12.5).
//
// SIGN-OUT IS NOT HERE either, and that is deliberate rather than an omission.
// It has one authoritative path: the reply to `auth.signOut`, not the push that
// fires partway through it (routes/Account.tsx). A second copy of that
// reasoning in a dropdown is a second place for it to drift.
import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  CheckTickSingle, ChevronSortVertical, ContactsBook, LogOutRight, PlusDefault,
  Settings01, UserTwo, Bot, UserPlus,
} from '@relayed/icons';
import type { AccountLabel } from '../../../../preload/api';
import { useSession } from '../../state';
import { call, hueFor, initials } from '@/lib/ipc';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar';
import { ActorAvatar } from '@/components/ActorAvatar';

export function AccountSwitcher() {
  const { state, apply } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // Present on `authenticated` as well as `needs_workspace`: an invitation
  // accepted after you already had a workspace of your own (session.ts).
  const pendingJoins = state.auth.status === 'authenticated' || state.auth.status === 'needs_workspace'
    ? state.auth.pendingJoins
    : [];
  const { wsId } = useParams();
  const me = state.workspaces.find(w => w.workspaceId === (wsId ?? state.workspaceId));

  // Every call is fired with `void`, so each catches its own rejection — an
  // unguarded one would be unhandled rather than shown (invariant 54).
  const switchTo = useCallback(async (accountId: string) => {
    setError(null);
    try {
      const next = await call(api => api.query('account.switch', { accountId }));
      if (!next) return;
      apply(next);
      if (next.workspaceId) void navigate(`/w/${next.workspaceId}`);
    } catch (e) { setError((e as Error).message); }
  }, [apply, navigate]);

  // Not awaited into a local flag: it resolves only when the browser comes
  // back, and the wait is pushed as `addingAccount` so a reload keeps it.
  const addAccount = useCallback(() => {
    setError(null);
    void call(api => api.query('auth.addAccount'))
      .then((next) => {
        if (!next) return;
        apply(next);
        // Onboarding for an account with no workspace is routed by "/";
        // otherwise go wherever the new account landed.
        void navigate(next.auth.status === 'needs_workspace' || !next.workspaceId
          ? '/' : `/w/${next.workspaceId}`);
      })
      .catch((e: Error) => setError(e.message));
  }, [apply, navigate]);

  const cancelAdd = useCallback(async () => {
    try { apply(await call(api => api.query('auth.cancelAddAccount'))); }
    catch (e) { setError((e as Error).message); }
  }, [apply]);

  const reopen = useCallback(async () => {
    try { await call(api => api.query('auth.reopenBrowser')); }
    catch (e) { setError((e as Error).message); }
  }, []);

  if (!me) return null;

  return (
    <SidebarMenu>
      {state.addingAccount === 'browser' && (
        <SidebarMenuItem className="space-y-2 rounded-2xl border p-3 text-xs text-muted-foreground">
          <p>Adding an account. Finish signing in in your browser.</p>
          <div className="flex gap-1">
            <Button size="xs" variant="secondary" onClick={() => void reopen()}>Open again</Button>
            <Button size="xs" variant="ghost" onClick={() => void cancelAdd()}>Cancel</Button>
          </div>
        </SidebarMenuItem>
      )}
      {error && (
        <SidebarMenuItem className="rounded-2xl border border-destructive/40 p-3 text-xs text-destructive">
          <button type="button" className="text-left" onClick={() => setError(null)}>{error}</button>
        </SidebarMenuItem>
      )}
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton  className="gap-2 rounded-2xl" />}>
            <ActorAvatar
              id={me.actorId} fallbackName={me.actorDisplayName} fallbackBlob={me.actorAvatarBlob}
              className="size-5" fallbackClassName="rounded-lg text-[10px]"
            />
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

            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Accounts
              </DropdownMenuLabel>
              {state.accounts.map(account => (
                <AccountItem
                  key={account.accountId}
                  account={account}
                  current={account.accountId === state.accountId}
                  onSelect={() => void switchTo(account.accountId)}
                />
              ))}
              <DropdownMenuItem
                disabled={state.addingAccount !== null}
                onClick={addAccount}
                className="gap-2"
              >
                <div className="grid size-5 place-items-center rounded-lg border bg-background">
                  <PlusDefault className="size-3" />
                </div>
                <span className="text-muted-foreground">Add account</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            {/* Account tier: no workspace replica is open and none is needed
                (STORAGE.md §5). The route sits outside /w/ for that reason. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                This account
              </DropdownMenuLabel>
              {/* A workspace admitted you and you have no actor in it yet. It
                  cannot live under /w/ — it is about a workspace you are not in
                  — and it is easy to have no idea it is waiting, so it is
                  surfaced HERE rather than only inside settings. */}
              {pendingJoins.length > 0 && (
                <DropdownMenuItem render={<Link to="/settings/invitations" />}>
                  <UserPlus className="size-4 text-muted-foreground" />
                  {pendingJoins.length === 1
                    ? `Join ${pendingJoins[0]?.name ?? 'workspace'}`
                    : `${pendingJoins.length} pending invitations`}
                </DropdownMenuItem>
              )}
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

/**
 * One account on this device. Initials rather than a photo: avatar bytes are
 * served for the OPEN account only (`blob:account`), so another account's
 * face would be a broken image until you switched to it.
 */
function AccountItem({ account, current, onSelect }: {
  account: AccountLabel;
  current: boolean;
  onSelect: () => void;
}) {
  // The email is what tells two accounts of one person apart — both are
  // usually the same name. The workspace line stands in until the account next
  // signs in through the browser, which is when its email is first recorded.
  const detail = account.email ?? (account.workspaces > 1
    ? `${account.workspaceName} · ${account.workspaces} workspaces`
    : account.workspaceName);
  return (
    <DropdownMenuItem
      onClick={current ? undefined : onSelect}
      className="gap-2"
    >
      <div
        className="grid size-5 shrink-0 place-items-center rounded-lg text-[10px] font-medium text-foreground/90"
        style={{ backgroundColor: `oklch(0.34 0.07 ${hueFor(account.accountId)})` }}
      >
        {initials(account.displayName)}
      </div>
      <div className="grid min-w-0 flex-1 leading-tight">
        <span className="truncate text-sm">{account.displayName || account.handle}</span>
        <span className="truncate text-xs text-muted-foreground" title={detail}>{detail}</span>
      </div>
      {current && <CheckTickSingle className="size-4 shrink-0 text-muted-foreground" />}
    </DropdownMenuItem>
  );
}
