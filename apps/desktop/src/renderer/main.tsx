import './index.css';
// DialKit is temporarily disabled. Keep the integration in place so the design
// controls can be restored without reconstructing their configuration.
// import 'dialkit/styles.css';
// Before anything that reaches @openuidev/react-lang (the message renderer).
// See the module for the two things it switches off.
import '@/app/openui-setup';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// import { DialRoot } from 'dialkit';
import { HashRouter } from 'react-router';
import { AppStateProvider } from '@/app/state';
import { Router } from '@/app/router';
import { Telemetry } from '@/app/Telemetry';
import { Theme } from '@/app/Theme';
import { TopBar } from '@/app/shell/TopBar';
import { SearchPalette } from '@/app/shell/SearchPalette';
import { AppCommands } from '@/app/shell/AppCommands';
import { SidebarProvider } from '@/components/ui/sidebar';
import { Commands } from '@/app/Commands';

// The FIRST GUESS, before React mounts and before the stored preference has
// been read: whatever this machine is set to. `<Theme />` below takes over from
// here and corrects it, which is the only thing that knows about `light` and
// `dark`. Painting something now rather than waiting is what keeps a cold start
// from flashing an unstyled document (PREFERENCES.md §9).
document.documentElement.classList.toggle(
  'dark', window.matchMedia('(prefers-color-scheme: dark)').matches,
);

// Hash history, not browser history (FRONTEND.md §4.4). The production renderer
// loads from file://, where pushState paths break on reload; the hash survives
// it, and survives it identically under the dev server. One code path in both,
// which matters more here than the cosmetics — nobody sees the URL anyway.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <AppStateProvider>
        {/* Renders nothing; reports the two facts only this side holds — which
            route is showing, and when it first actually painted. */}
        <Telemetry />

        {/* Renders nothing; owns `html.dark`. Inside the provider because the
            preference is an ordinary live read, and above the router because
            every screen is themed — including the signed-out ones. */}
        <Theme />

        {/* THE PROVIDER IS AT THE ROOT so the top bar can hold the sidebar's
            toggle. It is state plus a wrapper div, and the wrapper takes our
            className — a COLUMN here, so the bar spans the whole window and the
            sidebar and the route share the row beneath it. The block this is
            based on puts its header inside the inset instead, which gives a bar
            that stops where the sidebar starts.

            Its own persistence is a no-op in this app — it writes a cookie that
            nothing reads, a server-rendering trick that is dead on file:// —
            so the toggle is deliberately session-only until there is somewhere
            honest to keep it. */}
        {/* The command bus: one keyboard listener and every command handler,
            for the window's lifetime (SHORTCUTS.md §6.2). */}
        <Commands>
        <SidebarProvider className="h-svh min-h-0 flex-col overflow-hidden">
          {/* Outside the route tree on purpose, and above it: it is the window's
              title bar now, so every screen needs it — including the ones a cut
              network or a signed-out session strands you on. */}
          <TopBar />
          {/* The search dialog and its command, for every route (SHORTCUTS.md §10). */}
          <SearchPalette />
          {/* Renders nothing: the settings and shortcuts commands, for every route. */}
          <AppCommands />
          <div className="flex min-h-0 flex-1">
            <Router />
          </div>
        </SidebarProvider>
        </Commands>
      </AppStateProvider>
    </HashRouter>
    {/* <DialRoot /> */}
  </StrictMode>,
);
