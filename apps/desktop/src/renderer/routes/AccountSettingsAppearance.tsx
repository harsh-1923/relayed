import { SettingsPanel } from '@/features/settings/SettingsPanel';

const APPEARANCE_SETTINGS = [
  {
    label: 'Theme',
    description: 'Match the light or dark appearance selected on this device.',
    value: 'System',
  },
  {
    label: 'Window material',
    description: 'Use the native translucent material for app chrome.',
    value: 'Translucent',
  },
] as const;

export function AccountSettingsAppearance() {
  return (
    <SettingsPanel
      title="Appearance"
      description="How Relayed looks on this device."
      items={APPEARANCE_SETTINGS}
    />
  );
}
