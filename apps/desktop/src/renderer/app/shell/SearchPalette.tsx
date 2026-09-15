// The search dialog, and the `app.search.open` handler (SHORTCUTS.md §10).
//
// At the root rather than in AppSidebar, which is where it used to live along
// with its own window listener. Settings replaces AppSidebar with
// SettingsSidebar, so Mod+K disappeared exactly where a person might go to look
// it up. Mounted beside the top bar, its lifetime is the window's.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { PluginAddonPuzzle, UserTwo } from '@relayed/icons';
import { useSession } from '../state';
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput,
  CommandItem, CommandList,
} from '@/components/ui/command';
import { useCommandHandler } from '@/lib/commands/CommandProvider';

/**
 * Destinations that exist. A row here is a promise that selecting it goes
 * somewhere, so nothing is listed ahead of the screen it would open.
 * Workspace-tier, so absent while no workspace is open.
 */
export const destinationsFor = (wsId: string | null) => wsId === null ? [] : [
  { label: 'People', icon: UserTwo, to: `/w/${wsId}/people` },
  { label: 'Connectors', icon: PluginAddonPuzzle, to: `/w/${wsId}/connectors` },
];

export function SearchPalette() {
  // From state, not the URL: a local room's route has no workspace in its path.
  const wsId = useSession().state.workspaceId;
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const destinations = destinationsFor(wsId);

  // Everything it can find today is workspace-tier, so there is nothing to
  // search — and no dialog to open — before a workspace is.
  useCommandHandler('app.search.open', { layer: 'application', enabled: wsId !== null, run: () => setOpen(true) });

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search Relayed"
      description="Search for a space, person or action"
    >
      <Command>
        <CommandInput autoFocus placeholder="Search Relayed…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Go to">
            {destinations.map(destination => {
              const Icon = destination.icon;
              return (
                <CommandItem
                  key={destination.label}
                  value={destination.label}
                  onSelect={() => {
                    setOpen(false);
                    void navigate(destination.to);
                  }}
                >
                  <Icon />
                  <span>{destination.label}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
