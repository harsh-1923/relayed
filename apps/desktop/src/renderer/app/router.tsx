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
import { AppShell } from './AppShell';
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

      {/* A pathless layout route: the rail and the signed-out guard, shared by
          everything below without adding a path segment. */}
      <Route element={<AppShell />}>
        <Route path="/account" element={<Account />} />

        {/* The gate turns a URL into a switch, and is the ONLY caller of
            workspace.switch (invariant 56). */}
        <Route path="/w/:wsId" element={<WorkspaceGate />}>
          <Route index element={<WorkspaceHome />} />
          {/* §4.6 settles the space route as /w/:wsId/s/:spaceId. A chat is
              addressed directly because that is what the sidebar links to and
              what a person means by "open #general" — the space is derivable
              from the chat, and the reverse needs a second lookup. */}
          <Route path="c/:chatId" element={<Chat />} />
          <Route path="people" element={<People />} />
          <Route path="settings" element={<Settings />}>
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
