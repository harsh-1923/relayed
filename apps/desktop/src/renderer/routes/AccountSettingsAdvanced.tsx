import { SettingsPanel } from '@/features/settings/SettingsPanel';

const ADVANCED_SETTINGS = [
  {
    label: 'Local data',
    description: 'Keep readable workspace replicas on this device.',
    value: 'Enabled',
  },
  {
    label: 'Diagnostics',
    description: 'Collect structured operational signals without message content.',
    value: 'Standard',
  },
] as const;

export function AccountSettingsAdvanced() {
  return (
    <SettingsPanel
      title="Advanced"
      description="Local storage and diagnostics for this installation."
      items={ADVANCED_SETTINGS}
    />
  );
}
