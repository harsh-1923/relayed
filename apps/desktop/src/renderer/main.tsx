import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import { AppStateProvider } from '@/app/state';
import { Router } from '@/app/router';
import { Telemetry } from '@/app/Telemetry';
import { DevStrip } from '@/features/dev/DevStrip';

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
        <Router />
        {/* Outside the route tree on purpose: a control that can cut the
            network must be reachable from every screen, including the ones a
            cut network strands you on. */}
        <DevStrip />
      </AppStateProvider>
    </HashRouter>
  </StrictMode>,
);
