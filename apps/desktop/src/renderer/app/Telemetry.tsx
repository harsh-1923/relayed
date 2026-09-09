// Route changes and first paint (OBSERVABILITY.md §3, FRONTEND.md §10).
//
// Renders nothing. It exists because both signals are facts only the renderer
// holds: which URL is showing, and the frame in which it actually appeared.
//
// Mounted inside AppStateProvider on purpose. The provider paints a bare
// background until state arrives, and reporting THAT as first paint would make
// R3 look better than it is — the number people care about is when the routed
// UI appeared, not when the window stopped being white.
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { emit, reportFirstPaint } from '@/lib/telemetry';
import { useSession } from './state';

export function Telemetry() {
  const { pathname } = useLocation();
  const { state } = useSession();
  const previous = useRef<string | null>(null);

  useEffect(() => {
    // After the frame commits, not merely after the effect runs: an effect
    // fires before the browser has painted, and the claim being measured is
    // that something was on screen.
    const frame = requestAnimationFrame(() => { reportFirstPaint(); });
    return () => { cancelAnimationFrame(frame); };
  }, []);

  useEffect(() => {
    if (previous.current === pathname) return;
    // An event, not a metric, so it may carry ids — a route path contains them
    // and a metric label never may (OBSERVABILITY.md §5).
    emit('ui.route.changed', {
      from: previous.current ?? '',
      to: pathname,
      workspace: state.workspaceId ?? '',
    });
    previous.current = pathname;
  }, [pathname, state.workspaceId]);

  return null;
}
