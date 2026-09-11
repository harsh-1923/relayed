// The frame every signed-in surface sits in: sidebar on the left, route in the
// inset beside it.
//
// A pathless layout route, so it adds no path segment. /account and /w/:wsId
// both nest under it.
//
// The TOP BAR is not here. It is at the root, above the router, because once it
// is also the window's title bar every screen needs it — including the ones
// outside this shell (see ./TopBar.tsx).
import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { useSession } from '../state';
import { AppSidebar } from './sidebar/AppSidebar';
import { SidebarInset } from '@/components/ui/sidebar';
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
    // `void`: react-router's navigate returns a promise, and a client-side
    // navigation has nothing to reject with. Marked rather than awaited so the
    // rule that catches REAL unhandled rejections stays on (invariant 54).
    if (stranded) void navigate('/', { replace: true });
  }, [stranded, navigate]);

  return (
    <>
      {/* Only inside a workspace: the directory reads the workspace replica,
          and /account is account-tier where no replica is open (STORAGE.md §5).
          Rendering it there would be a read against a database that is not. */}
      {state.workspaceId && <AppSidebar />}
      {/* `min-h-0` so a route that fills its height — the chat scroller — is
          bounded by the window rather than growing past it. Without it a flex
          child's `min-height: auto` lets the message list push the composer
          off the bottom of the screen. */}
      <SidebarInset className="min-h-0">
        <Outlet />
      </SidebarInset>
    </>
  );
}
