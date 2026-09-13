// The route tree (FRONTEND.md §4.6).
//
// Declarative mode: routes match URLs and nothing else. No loaders — data
// arrives through the live-query client on a push, which correlates with
// navigation not at all (§4.3).
//
// Space routes are deliberately absent. §4.6 settles their shape
// (/w/:wsId/s/:spaceId, panes in the query) and they arrive with the first
// real surface; adding empty ones now would be scaffolding nobody can test.
import { Navigate, Route, Routes } from 'react-router';
import { AppShell } from './shell/AppShell';
import { Page } from './shell/Page';
import { WorkspaceGate } from './WorkspaceGate';
import { RootRedirect } from './RootRedirect';
import { SignIn } from '@/routes/SignIn';
import { Onboarding } from '@/routes/Onboarding';
import { CreateWorkspace } from '@/routes/CreateWorkspace';
import { JoinWorkspace } from '@/routes/JoinWorkspace';
import { WorkspaceHome } from '@/routes/WorkspaceHome';
import { People } from '@/routes/People';
import { Chat } from '@/routes/Chat';
import { Settings } from '@/routes/Settings';
import { SettingsMembers } from '@/routes/SettingsMembers';
import { SettingsProfile } from '@/routes/SettingsProfile';
import { Account } from '@/routes/Account';
import { AccountSettings } from '@/routes/AccountSettings';
import { AccountSettingsAdvanced } from '@/routes/AccountSettingsAdvanced';
import { AccountSettingsAppearance } from '@/routes/AccountSettingsAppearance';
import { AccountSettingsAgent } from '@/routes/AccountSettingsAgent';
import { AccountSettingsGeneral } from '@/routes/AccountSettingsGeneral';
import { AccountSettingsNotifications } from '@/routes/AccountSettingsNotifications';
import { NotFound } from '@/routes/NotFound';

export function Router() {
  return (
    <Routes>
      {/* Decides where you belong from state, rather than guessing. */}
      <Route path="/" element={<RootRedirect />} />
      <Route path="/signin" element={<SignIn />} />

      {/* Account tier: no workspace replica is open, so nothing here may
          read one (STORAGE.md §5). */}
      <Route path="/onboarding" element={<Onboarding />}>
        <Route index element={<Navigate to="create" replace />} />
        <Route path="create" element={<CreateWorkspace />} />
        <Route path="join" element={<JoinWorkspace />} />
      </Route>

      {/* A pathless layout route: the sidebar and the signed-out guard, shared
          by everything below without adding a path segment.

          `Page` is what pads a surface and makes it the thing that scrolls.
          Chat is deliberately NOT wrapped: it fills the pane and owns its own
          scroll container (see shell/Page.tsx). */}
      <Route element={<AppShell />}>
        <Route path="/account" element={<Page><Account /></Page>} />
        {/* A local room's chat (LOCAL-ROOMS.md §11.3): the synced chat's view, in
            the local scope. Outside /w/ because a local room is account-tier. */}
        <Route path="/local/c/:chatId" element={<Chat scope="local" />} />
        <Route path="/settings" element={<Page><AccountSettings /></Page>}>
          <Route index element={<Navigate to="general" replace />} />
          <Route path="general" element={<AccountSettingsGeneral />} />
          <Route path="appearance" element={<AccountSettingsAppearance />} />
          <Route path="agent" element={<AccountSettingsAgent />} />
          <Route path="notifications" element={<AccountSettingsNotifications />} />
          <Route path="advanced" element={<AccountSettingsAdvanced />} />
        </Route>

        {/* The gate turns a URL into a switch, and is the ONLY caller of
            workspace.switch (invariant 56). */}
        <Route path="/w/:wsId" element={<WorkspaceGate />}>
          <Route index element={<Page><WorkspaceHome /></Page>} />
          {/* §4.6 settles the space route as /w/:wsId/s/:spaceId. A chat is
              addressed directly because that is what the sidebar links to and
              what a person means by "open #general" — the space is derivable
              from the chat, and the reverse needs a second lookup. */}
          <Route path="c/:chatId" element={<Chat />} />
          <Route path="people" element={<Page><People /></Page>} />
          <Route path="settings" element={<Page><Settings /></Page>}>
            <Route index element={<Navigate to="members" replace />} />
            <Route path="members" element={<SettingsMembers />} />
            <Route path="profile" element={<SettingsProfile />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
