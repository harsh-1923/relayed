import type { PropsWithChildren } from 'react';
import { SidebarProvider } from '@/components/ui/sidebar';
import { usePreference } from '@/lib/prefs';

/**
 * Keeps desktop collapse state in account.db while leaving the signed-out and
 * mobile sidebars session-local. Mobile opens a temporary overlay rather than
 * changing the desktop preference.
 */
export function PersistentSidebarProvider({ children }: PropsWithChildren) {
  const sidebarOpen = usePreference('shell.sidebar.open');

  return (
    <SidebarProvider
      open={sidebarOpen.writable ? sidebarOpen.value : undefined}
      onOpenChange={sidebarOpen.writable ? sidebarOpen.set : undefined}
      className="h-svh min-h-0 flex-col overflow-hidden"
    >
      {children}
    </SidebarProvider>
  );
}
