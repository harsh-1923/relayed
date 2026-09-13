// Handlers for application commands that only navigate (SHORTCUTS.md §10).
//
// Renders nothing. Mounted at the root beside the search palette, so ⌘, and ⌘/
// work on every route — including settings, where they are most likely to be
// tried — for as long as there is an account whose settings to show.
import { useNavigate } from 'react-router';
import { useSession } from '../state';
import { useCommandHandler } from '@/lib/commands/CommandProvider';

export function AppCommands() {
  const navigate = useNavigate();
  const signedIn = useSession().state.accountId !== null;

  useCommandHandler('app.settings.open', {
    layer: 'application', enabled: signedIn, run: () => void navigate('/settings/general'),
  });
  useCommandHandler('app.shortcuts.open', {
    layer: 'application', enabled: signedIn, run: () => void navigate('/settings/shortcuts'),
  });

  return null;
}
