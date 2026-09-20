// The route tree (FRONTEND.md §4.6).
//
// Declarative mode: routes match URLs and nothing else. No loaders — data
// arrives through the live-query client on a push, which correlates with
// navigation not at all (§4.3).
//
// A space is addressed by its id, in both scopes: /w/:wsId/s/:spaceId and
// /local/s/:spaceId (§4.6). Never by chat — a side chat opens in a panel beside
// the space, and panels are view state in the query (§4.7).
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
import { Space } from '@/routes/Space';
import { Settings } from '@/routes/Settings';
import { SettingsMembers } from '@/routes/SettingsMembers';
import { SettingsProfile } from '@/routes/SettingsProfile';
import { SettingsAgents } from '@/routes/SettingsAgents';
import { Apps, AppsCatalogue, InstalledApps } from '@/routes/Apps';
import { SettingsAgentEditor } from '@/routes/SettingsAgentEditor';
import { AgentProfile } from '@/features/agents/AgentProfile';
import { Account } from '@/routes/Account';
import { AccountSettings } from '@/routes/AccountSettings';
import { AccountSettingsAdvanced } from '@/routes/AccountSettingsAdvanced';
import { AccountSettingsBrowsers } from '@/routes/AccountSettingsBrowsers';
import { AccountSettingsAppearance } from '@/routes/AccountSettingsAppearance';
import { AccountSettingsInvitations } from '@/routes/AccountSettingsInvitations';
import { AccountSettingsAgent } from '@/routes/AccountSettingsAgent';
import { AccountSettingsDevelopers } from '@/routes/AccountSettingsDevelopers';
import { AccountSettingsGeneral } from '@/routes/AccountSettingsGeneral';
import { AccountSettingsNotifications } from '@/routes/AccountSettingsNotifications';
import { AccountSettingsShortcuts } from '@/routes/AccountSettingsShortcuts';
import { NotFound } from '@/routes/NotFound';
import { UpdateGate } from '@/features/update/UpdateGate';

export function Router() {
  return (
    // OUTSIDE the routes, because a required update is not a place you navigate
    // to — it replaces every route, including sign-in, which a build below the
    // floor should not be starting either.
    <UpdateGate>
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
          Space is deliberately NOT wrapped: it fills the pane and owns its own
          scroll container (see shell/Page.tsx). */}
      <Route element={<AppShell />}>
        <Route path="/account" element={<Page><Account /></Page>} />
        {/* A local room (LOCAL-ROOMS.md §11.3): the synced space's view, in the
            local scope. Outside /w/ because a local room is account-tier. */}
        <Route path="/local/s/:spaceId" element={<Space scope="local" />} />
        <Route path="/settings" element={<Page><AccountSettings /></Page>}>
          <Route index element={<Navigate to="general" replace />} />
          <Route path="general" element={<AccountSettingsGeneral />} />
          <Route path="appearance" element={<AccountSettingsAppearance />} />
          <Route path="invitations" element={<AccountSettingsInvitations />} />
          <Route path="agent" element={<AccountSettingsAgent />} />
          <Route path="notifications" element={<AccountSettingsNotifications />} />
          <Route path="shortcuts" element={<AccountSettingsShortcuts />} />
          <Route path="browsers" element={<AccountSettingsBrowsers />} />
          <Route path="advanced" element={<AccountSettingsAdvanced />} />
          <Route path="developers" element={<AccountSettingsDevelopers />} />
        </Route>

        {/* The gate turns a URL into a switch, and is the ONLY caller of
            workspace.switch (invariant 56). */}
        <Route path="/w/:wsId" element={<WorkspaceGate />}>
          <Route index element={<Page><WorkspaceHome /></Page>} />
          <Route path="s/:spaceId" element={<Space />} />
          <Route path="people" element={<Page><People /></Page>} />
          <Route path="apps" element={<Page className="pt-0 [scrollbar-gutter:stable]"><Apps /></Page>}>
            <Route index element={<AppsCatalogue />} />
            <Route path="installed" element={<InstalledApps />} />
          </Route>
          <Route path="connectors" element={<Navigate to="../apps" relative="path" replace />} />
          <Route path="settings" element={<Page><Settings /></Page>}>
            <Route index element={<Navigate to="members" replace />} />
            <Route path="members" element={<SettingsMembers />} />
            <Route path="profile" element={<SettingsProfile />} />
            <Route path="agents" element={<SettingsAgents />} />
            <Route path="apps" element={<Navigate to="../../apps" replace />} />
            <Route path="connectors" element={<Navigate to="../../apps" replace />} />
            <Route path="agents/new" element={<SettingsAgentEditor />} />
            <Route path="agents/:agentId" element={<AgentProfile />} />
            <Route path="agents/:agentId/edit" element={<SettingsAgentEditor />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
    </UpdateGate>
  );
}
