import { SettingsPanel } from '@/features/settings/SettingsPanel';

const NOTIFICATION_SETTINGS = [
  {
    label: 'Mentions',
    description: 'Notify when someone mentions you directly.',
    value: 'Always',
  },
  {
    label: 'Workspace activity',
    description: 'Use each workspace’s notification defaults.',
    value: 'Per workspace',
  },
] as const;

export function AccountSettingsNotifications() {
  return (
    <SettingsPanel
      title="Notifications"
      description="Choose what deserves your attention."
      items={NOTIFICATION_SETTINGS}
    />
  );
}
