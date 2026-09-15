// The frame every signed-in surface sits in: sidebar on the left, route in the
// inset beside it.
//
// A pathless layout route, so it adds no path segment. /account and /w/:wsId
// both nest under it.
//
// The TOP BAR is not here. It is at the root, above the router, because once it
// is also the window's title bar every screen needs it — including the ones
// outside this shell (see ./TopBar.tsx).
import { useEffect, useRef } from 'react';
import {
  usePanelRef, type Layout, type LayoutChangedMeta, type PanelSize,
} from 'react-resizable-panels';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { useSession } from '../state';
import { AppSidebar } from './sidebar/AppSidebar';
import { SettingsSidebar } from './sidebar/SettingsSidebar';
import {
  ResizableHandle, ResizablePanel, ResizablePanelGroup,
} from '@/components/ui/resizable';
import { SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { usePreference } from '@/lib/prefs';
import { useQueryInvalidation } from '@/lib/query';

const SIDEBAR_MIN_WIDTH = 224;
const SIDEBAR_MAX_WIDTH = 320;
const SIDEBAR_CLICK_SLOP_PX = 4;

export function AppShell() {
  const { state } = useSession();
  const { isMobile, open, setOpen, toggleSidebar } = useSidebar();
  const navigate = useNavigate();
  const location = useLocation();
  const sidebarPanelRef = usePanelRef();
  const sidebarPointerDownX = useRef<number | null>(null);
  const sidebarOpenRef = useRef(open);
  const sidebarWidth = usePreference('shell.sidebar.width');
  const lastExpandedSidebarWidth = useRef(sidebarWidth.value);
  const isAccountSettings = location.pathname === '/settings'
    || location.pathname.startsWith('/settings/');
  const hasSidebar = isAccountSettings || state.workspaceId !== null;

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

  // The panel owns desktop width and collapse mechanics. The provider still
  // owns the title-bar button, keyboard shortcut, and mobile sheet, so these two
  // small bridges keep those controls aligned with drag-to-collapse.
  useEffect(() => {
    sidebarOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    lastExpandedSidebarWidth.current = sidebarWidth.value;
  }, [sidebarWidth.value]);

  useEffect(() => {
    if (isMobile || !hasSidebar) return;

    const sidebarPanel = sidebarPanelRef.current;
    if (!sidebarPanel) return;

    if (open) sidebarPanel.resize(sidebarWidth.value);
    else sidebarPanel.collapse();
  }, [hasSidebar, isMobile, open, sidebarPanelRef, sidebarWidth.value]);

  function handleSidebarResize(panelSize: PanelSize) {
    document.documentElement.style.setProperty(
      '--workspace-sidebar-width',
      `${panelSize.inPixels}px`,
    );

    const resizedOpen = panelSize.inPixels > 0;
    if (resizedOpen) {
      lastExpandedSidebarWidth.current = Math.round(panelSize.inPixels);
    }
    if (resizedOpen !== sidebarOpenRef.current) {
      sidebarOpenRef.current = resizedOpen;
      setOpen(resizedOpen);
    }
  }

  function handleSidebarLayoutChanged(
    _completedLayout: Layout, meta: LayoutChangedMeta,
  ) {
    // The panel's onResize keeps the title bar aligned during the drag. Persist
    // only after direct manipulation ends, never for mount, window resize or
    // the imperative resize used to restore a preference.
    if (!meta.isUserInteraction || !sidebarWidth.writable) return;

    const nextWidth = lastExpandedSidebarWidth.current;
    if (nextWidth !== sidebarWidth.value) sidebarWidth.set(nextWidth);
  }

  // Pointer Events do not guarantee that a drag suppresses the following
  // click. A drag leaves the panel where it was dropped; a click toggles it.
  function handleSidebarClick(event: React.MouseEvent) {
    const pointerDownX = sidebarPointerDownX.current;
    sidebarPointerDownX.current = null;

    if (pointerDownX === null
        || Math.abs(event.clientX - pointerDownX) <= SIDEBAR_CLICK_SLOP_PX) {
      toggleSidebar();
    }
  }

  const route = (
    <SidebarInset className="h-full min-h-0 min-w-0">
      <Outlet />
    </SidebarInset>
  );

  // Mobile keeps shadcn's Sheet: it overlays the route instead of taking width
  // from it, and AppSidebar offsets the sheet below the window title bar.
  if (isMobile || !hasSidebar) {
    return (
      <>
        {hasSidebar && (isAccountSettings ? <SettingsSidebar /> : <AppSidebar />)}
        {route}
      </>
    );
  }

  return (
    <ResizablePanelGroup
      id="workspace-shell"
      orientation="horizontal"
      className="min-h-0 flex-1"
      onLayoutChanged={handleSidebarLayoutChanged}
    >
      <ResizablePanel
        id="workspace-sidebar"
        panelRef={sidebarPanelRef}
        defaultSize={sidebarWidth.value}
        minSize={SIDEBAR_MIN_WIDTH}
        maxSize={SIDEBAR_MAX_WIDTH}
        collapsedSize={0}
        collapsible
        groupResizeBehavior="preserve-pixel-size"
        onResize={handleSidebarResize}
        className="min-w-0 overflow-hidden"
      >
        {isAccountSettings ? <SettingsSidebar inline /> : <AppSidebar inline />}
      </ResizablePanel>

      <ResizableHandle
        aria-label="Resize or toggle sidebar"
        title="Drag to resize, click to toggle"
        onPointerDown={(event) => {
          sidebarPointerDownX.current = event.clientX;
        }}
        onClick={handleSidebarClick}
        onPointerCancel={() => {
          sidebarPointerDownX.current = null;
        }}
        className="z-20 bg-transparent after:w-3 focus-visible:ring-0"
      />

      {/* `min-h-0` bounds a route-height scroller; `min-w-0` lets narrow
          windows shrink the route instead of forcing the sidebar past max. */}
      <ResizablePanel id="workspace-content" className="min-h-0 min-w-0">
        {route}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
