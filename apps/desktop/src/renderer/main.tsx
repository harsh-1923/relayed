import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import { AppStateProvider } from '@/app/state';
import { Router } from '@/app/router';
import { Telemetry } from '@/app/Telemetry';
import { TopBar } from '@/app/shell/TopBar';
import { SidebarProvider } from '@/components/ui/sidebar';

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
        <SidebarProvider className="h-svh min-h-0 flex-col overflow-hidden">
          {/* Outside the route tree on purpose, and above it: it is the window's
              title bar now, so every screen needs it — including the ones a cut
              network or a signed-out session strands you on. */}
          <TopBar />
          <div className="flex min-h-0 flex-1">
            <Router />
          </div>
        </SidebarProvider>
      </AppStateProvider>
    </HashRouter>
  </StrictMode>,
);
