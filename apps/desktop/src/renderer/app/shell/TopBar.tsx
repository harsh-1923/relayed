// The top bar, which is also the window's title bar.
//
// AT THE ROOT, above the router, and that is not a layout preference. Once
// `titleBarStyle: 'hiddenInset'` takes the real title bar away, the only thing
// left that can move the window is a drag region in the page — so every screen
// needs one, including `/signin`, where there is no shell. A bar that appears
// only once you are signed in is a sign-in screen you cannot move.
//
// It is also why the development controls live here rather than in the shell.
// DevStrip's own comment records the bug: inside the shell it was present on
// workspace routes and nowhere else, so going offline, signing out and landing
// on `/signin` left the app offline with no way back. Root-level keeps that
// closed while giving the control a home instead of a floating card.
//
// EVERY CONTROL IN HERE IS `no-drag`. A drag region swallows clicks, so a button
// inside one is inert until it opts out — and it still looks and hovers exactly
// like a button that works.
import { ChevronLeft, ChevronRight, PanelLeft } from 'lucide-react';
import { useSession } from '../state';
import { useBackForward } from './use-back-forward/use-back-forward';
import { useSidebarPresent } from './sidebar/use-sidebar-presence';
import { OfflineSwitch } from '@/features/dev/OfflineSwitch';
import { Button } from '@/components/ui/button';
import { useSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

/**
 * Room for the macOS traffic lights, which `hiddenInset` leaves floating over
 * whatever we paint underneath them. Paired with `trafficLightPosition` in
 * `main/index.ts` — the lights start at x=13 and the cluster is ~52px wide.
 */
const TRAFFIC_LIGHTS = 78;

export function TopBar() {
  const { state } = useSession();
  const { isMobile } = useSidebar();
  const { canBack, canForward, back, forward } = useBackForward();

  // Asked of the sidebar itself rather than worked out from the URL: a toggle
  // for a panel that is not on screen reports on nothing, and the route table
  // is not something to restate here (sidebar/use-sidebar-presence.ts).
  const hasSidebar = useSidebarPresent();
  const alignNavigationToSidebar = hasSidebar && !isMobile;

  return (
    <header
      className="drag-region relative z-60 flex h-10 shrink-0 items-center
                 bg-window-glass text-sidebar-foreground"
    >
      <div
        className={cn(
          'flex h-full shrink-0 items-center gap-1 pr-2',
          alignNavigationToSidebar && 'min-w-max',
        )}
        style={{
          paddingLeft: state.platform === 'darwin' ? TRAFFIC_LIGHTS : 8,
          width: alignNavigationToSidebar
            ? 'var(--workspace-sidebar-width, var(--sidebar-width))'
            : undefined,
        }}
      >
        {hasSidebar && <SidebarToggle />}

        <div className={cn('flex items-center gap-1', alignNavigationToSidebar && 'ml-auto')}>
          <Bare label="Back" onClick={back} disabled={!canBack}>
            <ChevronLeft className="size-4" />
          </Bare>
          <Bare label="Forward" onClick={forward} disabled={!canForward}>
            <ChevronRight className="size-4" />
          </Bare>
        </div>
      </div>

      {/* PAST THE RESIZE HANDLE THE BAR STOPS BEING CHROME.
          Left of it the bar continues the sidebar and keeps the window's
          material; right of it it continues the route, so it takes the same
          `bg-background` as the SidebarInset directly beneath it. The border is
          the handle's own 1px track carried up through the title bar, which is
          what makes the two edges land on the same column.

          Only when there IS a sidebar. On /signin and on mobile there is no
          split below to line up with, and the bar stays one surface. */}
      <div
        className={cn(
          'flex h-full min-w-0 flex-1 items-center pr-2 border-border',
          alignNavigationToSidebar && 'border-border bg-background border-b border-l'
        )}
      >
        {/* The empty middle IS the handle. Nothing lives here yet — search and
            the current space's name are the candidates — and until something
            does, the whole span is what you grab to move the window. */}
        <div className="min-w-0 flex-1" />

        <OfflineSwitch />
      </div>
    </header>
  );
}

/** `SidebarTrigger`, minus the drag region that would otherwise eat its click. */
function SidebarToggle() {
  const { toggleSidebar } = useSidebar();
  return (
    <Bare label="Toggle sidebar" onClick={toggleSidebar}>
      <PanelLeft className="size-4" />
    </Bare>
  );
}

/**
 * A title-bar button: quiet, square, and out of the drag region.
 *
 * Disabled rather than hidden, because a control that vanishes when it has
 * nothing to do makes the bar's contents jump as you navigate.
 */
function Bare({
  label, onClick, disabled, children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost" size="icon" aria-label={label} title={label}
      onClick={onClick} disabled={disabled}
      className={cn('no-drag size-7 text-muted-foreground hover:text-foreground',
                    'disabled:opacity-30')}
    >
      {children}
    </Button>
  );
}
