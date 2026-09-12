import { SettingsPanel } from '@/features/settings/SettingsPanel';
import { ThemeToggle } from '@/features/settings/ThemeToggle';

const APPEARANCE_SETTINGS = [
  {
    label: 'Theme',
    description: 'Light, dark, or whatever this device is set to.',
    value: <ThemeToggle />,
  },
  {
    // Still a placeholder, and reading as one. It is a preference in waiting —
    // one entry in the catalogue and a control — but PREFERENCES.md §11 is the
    // whole cost, so it lands with whoever wants it rather than now.
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
