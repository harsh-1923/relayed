// Catalogue commands, run from the menu through the same bus as their keys and
// buttons (SHORTCUTS.md). A command shows only while a handler would run it,
// so the list follows the screen: panel commands appear inside a room.
import type { ComponentType } from 'react';
import {
  ArrowLeft, ArrowRight, KeyboardWired, PlusDefault, Settings01, SidebarDefault, SidebarRightOpen,
} from '@relayed/icons';
import { definitionOf, type CommandId } from '../../../../shared/shortcuts/catalogue.ts';
import { useCommand } from '@/lib/commands/CommandProvider';
import type { CommandMenuItem, CommandMenuSection } from '../command-menu-context.ts';
import { CommandMenuGroup } from '../CommandMenuRow.tsx';

/**
 * The commands worth finding by name, in the order they are listed. Opening
 * search is left out, and so is sending a message, which needs a focused
 * composer the menu has just taken focus from.
 */
const ACTIONS: readonly { id: CommandId; icon: ComponentType<{ className?: string }> }[] = [
  { id: 'room.panels.newTab', icon: PlusDefault },
  { id: 'room.panels.toggle', icon: SidebarRightOpen },
  { id: 'shell.sidebar.toggle', icon: SidebarDefault },
  { id: 'navigation.back', icon: ArrowLeft },
  { id: 'navigation.forward', icon: ArrowRight },
  { id: 'app.settings.open', icon: Settings01 },
  { id: 'app.shortcuts.open', icon: KeyboardWired },
];

export const ACTION_SECTIONS: readonly CommandMenuSection[] = [{ id: 'actions', label: 'Actions' }];

export function ActionSource() {
  // ACTIONS is a module constant, so this calls the same hooks in the same
  // order on every render.
  const items = ACTIONS.map(({ id, icon }): CommandMenuItem | null => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const command = useCommand(id);
    if (!command.enabled) return null;
    const definition = definitionOf(id);
    return {
      id: `cmd:${id}`,
      label: definition.title,
      icon,
      keywords: [definition.title, definition.category],
      shortcut: command.shortcutLabel,
      perform: () => { command.execute(); },
    };
  }).filter(item => item !== null);

  return <CommandMenuGroup section="actions" heading="Actions" items={items} />;
}
