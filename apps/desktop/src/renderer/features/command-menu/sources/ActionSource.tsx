// Catalogue commands, run from the menu through the same bus as their keys and
// buttons (SHORTCUTS.md). A command shows only while a handler would run it,
// so the list follows the screen: panel commands appear inside a room.
import type { ComponentType } from 'react';
import {
  ArrowLeft, ArrowRight, KeyboardWired, PlusDefault, Settings01, SidebarDefault, SidebarRightOpen,
} from '@relayed/icons';
import { definitionOf, type CommandId } from '../../../../shared/shortcuts/catalogue.ts';
import { CommandGroup } from '@/components/ui/command';
import { useCommand } from '@/lib/commands/CommandProvider';
import { CommandMenuRow } from '../CommandMenuRow.tsx';

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

export function ActionSource() {
  return (
    <CommandGroup heading="Actions">
      {ACTIONS.map(action => <ActionRow key={action.id} {...action} />)}
    </CommandGroup>
  );
}

function ActionRow({ id, icon }: { id: CommandId; icon: ComponentType<{ className?: string }> }) {
  const command = useCommand(id);
  if (!command.enabled) return null;
  const definition = definitionOf(id);
  return (
    <CommandMenuRow
      item={{
        id: `cmd:${id}`,
        label: definition.title,
        icon,
        keywords: [definition.title, definition.category],
        shortcut: command.shortcutLabel,
        perform: () => { command.execute(); },
      }}
    />
  );
}
