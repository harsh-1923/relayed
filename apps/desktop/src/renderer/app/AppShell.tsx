// The frame every signed-in surface sits in: rail on the left, route in the
// middle, development strip at the bottom.
//
// A pathless layout route, so it adds no path segment. /account and
// /w/:wsId both nest under it and both get the rail.
import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { useSession } from './state';
import { WorkspaceRail } from './WorkspaceRail';
import { ChannelList } from '@/features/chat/ChannelList';
import { useQueryInvalidation } from '@/lib/query';

export function AppShell() {
  const { state } = useSession();
  const navigate = useNavigate();

  // Connects the live-query registry to the engine's invalidations, once for
  // the whole tree. Here rather than at module load so the subscription has a
  // teardown, and here rather than per-surface so a second reader cannot forget.
  // Surfaces call useQuery, which is live in its own right.
  useQueryInvalidation();

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
    <div className="flex h-svh bg-background text-foreground">
      <WorkspaceRail />
      {/* Only inside a workspace: the channel list reads the workspace replica,
          and /account is account-tier where no replica is open (STORAGE.md §5).
          Rendering it there would be a read against a database that is not. */}
      {state.workspaceId && <ChannelList />}
      {/* DevStrip is NOT here. It is fixed-position at the root, so it stays
          reachable from /signin and /onboarding too — see its own comment. */}
      <main className="min-w-0 flex-1 overflow-y-auto p-10"><Outlet /></main>
    </div>
  );
}
