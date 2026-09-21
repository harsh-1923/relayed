import { SettingsPanel } from '@/features/settings/SettingsPanel';
import { CheckForUpdates } from '@/features/update/CheckForUpdates';

const GENERAL_SETTINGS = [
  {
    label: 'Startup workspace',
    description: 'Return to the workspace you used most recently.',
    value: 'Last visited',
  },
  {
    label: 'Links',
    description: 'Open Relayed links in this app.',
    value: 'Relayed',
  },
  {
    label: 'Updates',
    description: 'Relayed checks on its own when it connects. This asks now.',
    value: <CheckForUpdates />,
  },
] as const;

export function AccountSettingsGeneral() {
  return (
    <SettingsPanel
      title="General"
      description="The defaults Relayed uses across every workspace."
      items={GENERAL_SETTINGS}
    />
  );
}
