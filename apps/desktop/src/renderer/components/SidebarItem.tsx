import type { ComponentType } from 'react';
import { NavLink } from 'react-router';
import {
  SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar';

interface SidebarItemProps {
  label: string;
  icon: ComponentType<{ className?: string }>;
  to?: string;
  isActive?: boolean;
  badge?: number;
  disabled?: boolean;
}

/** One visual and interaction contract for every destination in the app sidebar. */
export function SidebarItem({
  label, icon: Icon, to, isActive = false, badge = 0, disabled = false,
}: SidebarItemProps) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={to ? <NavLink to={to} /> : undefined}
        type={to ? undefined : 'button'}
        isActive={isActive}
        disabled={disabled}
        className="h-9 gap-2.5 px-2 text-[15px] text-(--sidebar-item-foreground)
                   hover:bg-(--sidebar-item-background)!
                   hover:text-(--sidebar-item-foreground)!
                   data-active:bg-(--sidebar-item-background)!
                   data-active:text-(--sidebar-item-foreground)!"
      >
        <Icon className="size-4" />
        <span className="truncate">{label}</span>
      </SidebarMenuButton>

      {badge > 0 && (
        <SidebarMenuBadge className="bg-destructive text-white">
          {badge > 99 ? '99+' : badge}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}
