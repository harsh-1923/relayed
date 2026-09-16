import type { ComponentProps, ComponentType } from 'react';
import { NavLink } from 'react-router';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

interface SidebarItemProps {
  label: string;
  icon: ComponentType<{ className?: string }>;
  to?: string;
  isActive?: boolean;
  badge?: number;
  disabled?: boolean;
  /** Styles the label only, e.g. a shimmer while it is being renamed. */
  labelClassName?: string;
}

/** One visual and interaction contract for every destination in the app sidebar. */
export function SidebarItem({
  label, icon: Icon, to, isActive = false, badge = 0, disabled = false, labelClassName, ...item
}: SidebarItemProps & Omit<ComponentProps<typeof SidebarMenuItem>, 'children'>) {
  return (
    // The rest go to the row itself, so a context menu or a double-click can wrap it.
    <SidebarMenuItem {...item} className={cn('min-w-0', item.className)}>
      <SidebarMenuButton
        render={to ? <NavLink to={to} /> : undefined}
        type={to ? undefined : 'button'}
        isActive={isActive}
        disabled={disabled}
        title={item.title ?? label}
        className={cn(
          'h-9 min-w-0 gap-2.5 px-2 text-[15px] text-(--sidebar-item-foreground)',
          'hover:bg-(--sidebar-item-background)!',
          'hover:text-(--sidebar-item-foreground)!',
          'data-active:bg-(--sidebar-item-background)!',
          'data-active:text-(--sidebar-item-foreground)!',
        )}
      >
        <Icon className="size-4 shrink-0" />
        <span className={cn('min-w-0 flex-1 truncate', labelClassName)}>{label}</span>
        {badge > 0 && (
          <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-destructive px-1 text-xs font-medium text-white tabular-nums select-none group-data-[collapsible=icon]:hidden">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
