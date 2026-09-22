// The row and the group every source renders through, so a place and an action
// look and behave the same and selecting either closes the menu first.
import { useEffect } from 'react';
import { CommandGroup, CommandItem, CommandShortcut } from '@/components/ui/command';
import {
  useActiveSection, useCommandMenu, type CommandMenuItem,
} from './command-menu-context.ts';

export function CommandMenuRow({ item }: { item: CommandMenuItem }) {
  const { run } = useCommandMenu();
  const Icon = item.icon;
  return (
    <CommandItem
      value={item.id}
      keywords={[...item.keywords]}
      disabled={item.disabled}
      onSelect={() => run(item.perform)}
    >
      {Icon ? <Icon /> : null}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.detail ? (
        <span className="max-w-40 truncate text-xs text-muted-foreground">{item.detail}</span>
      ) : null}
      {item.shortcut ? <CommandShortcut>{item.shortcut}</CommandShortcut> : null}
    </CommandItem>
  );
}

/**
 * cmdk hides a group none of whose rows match, so an empty one never shows its
 * heading. The tabs need to know a section exists before anything is typed,
 * which cmdk cannot tell them, so the group reports its own rows.
 */
export function CommandMenuGroup({
  section, heading, items,
}: {
  section: string;
  heading: string;
  items: readonly CommandMenuItem[];
}) {
  const { reportRows } = useCommandMenu();
  const active = useActiveSection();
  const hasRows = items.length > 0;

  useEffect(() => {
    reportRows(section, hasRows);
    return () => reportRows(section, false);
  }, [reportRows, section, hasRows]);

  if (!hasRows) return null;
  if (active !== null && active !== section) return null;
  return (
    <CommandGroup heading={heading}>
      {items.map(item => <CommandMenuRow key={item.id} item={item} />)}
    </CommandGroup>
  );
}
