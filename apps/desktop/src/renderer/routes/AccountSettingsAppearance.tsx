import { IconColorwayPicker } from '@/features/settings/IconColorwayPicker';
import { SettingsPanel } from '@/features/settings/SettingsPanel';
import { ThemeToggle } from '@/features/settings/ThemeToggle';

const APPEARANCE_SETTINGS = [
  {
    label: 'Theme',
    description: 'Light, dark, or whatever this device is set to.',
    value: <ThemeToggle />,
  },
  {
    label: 'App icon',
    // SAYS WHERE IT STOPS, deliberately. The Dock tile belongs to the running
    // app and can be replaced; Finder, Launchpad and Spotlight read the icon
    // inside the signed bundle, which cannot be rewritten without breaking the
    // signature (main/app-icon.ts). Somebody who picks Emerald and then finds
    // blue in Finder should have been told here rather than file a bug.
    description: 'The colorway Relayed is drawn in while it is running. The installed app keeps its original icon in Finder.',
    value: <IconColorwayPicker />,
    layout: 'stacked',
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
