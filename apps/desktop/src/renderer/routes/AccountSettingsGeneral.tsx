import { SettingsPanel } from '@/features/settings/SettingsPanel';

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
