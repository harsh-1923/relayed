// The frame every signed-in surface sits in: rail on the left, route in the
// middle, development strip at the bottom.
//
// A pathless layout route, so it adds no path segment. /account and
// /w/:wsId both nest under it and both get the rail.
import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { useSession } from './state';
import { WorkspaceRail } from './WorkspaceRail';

export function AppShell() {
  const { state } = useSession();
  const navigate = useNavigate();

  // The ONE case where the engine is allowed to move the URL (invariant 57):
  // the thing you were looking at has ceased to exist. Sign-out is the common
  // cause; being removed from your last workspace is the other. Everywhere
  // else navigation drives the engine and never the reverse.
  const stranded = state.workspaceId === null
    && !state.workspaces.some(w => w.state === 'active');

  useEffect(() => {
    if (stranded) navigate('/', { replace: true });
  }, [stranded, navigate]);

  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <WorkspaceRail />
      {/* DevStrip is NOT here. It is fixed-position at the root, so it stays
          reachable from /signin and /onboarding too — see its own comment. */}
      <main className="min-w-0 flex-1 space-y-6 p-10"><Outlet /></main>
    </div>
  );
}
