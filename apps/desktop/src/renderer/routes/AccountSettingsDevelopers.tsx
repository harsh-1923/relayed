import { SettingsPanel } from '@/features/settings/SettingsPanel';
import { Switch } from '@/components/ui/switch';
import { usePreference, type PreferenceHandle } from '@/lib/prefs';
import type { PreferenceKey, PreferenceValue } from '../../shared/prefs.ts';

/** The keys this control can drive: the boolean ones. */
type BooleanPreferenceKey = {
  [K in PreferenceKey]: PreferenceValue<K> extends boolean ? K : never
}[PreferenceKey];

/**
 * One switch, and the reasons it might not be usable yet.
 *
 * Extracted at the second toggle rather than the third: the disabled rule and
 * the signed-out title are the easy things to get subtly different between two
 * copies, and a developer setting that silently refuses to save is exactly the
 * kind of thing nobody files.
 */
function DeveloperSwitch<K extends BooleanPreferenceKey>({ label, preference }: {
  label: string;
  preference: PreferenceHandle<K>;
}) {
  return (
    <span title={preference.writable ? undefined : 'Sign in to change developer settings'}>
      <Switch
        aria-label={label}
        checked={preference.value as boolean}
        disabled={!preference.loaded || preference.saving || !preference.writable}
        onCheckedChange={next => preference.set(next as PreferenceValue<K>)}
      />
    </span>
  );
}

export function AccountSettingsDevelopers() {
  const routeStrip = usePreference('developer.route_strip.visible');
  const playground = usePreference('developer.avatar_playground.visible');

  return (
    <SettingsPanel
      title="Developers"
      description="Tools for inspecting what Relayed is doing on this device."
      items={[
        {
          label: 'Route strip',
          description: 'Show the current route and panel query in the top bar.',
          value: <DeveloperSwitch label="Show route strip" preference={routeStrip} />,
        },
        {
          label: 'Avatar playground',
          description: 'Show the bench for tuning generated agent faces in the sidebar.',
          value: <DeveloperSwitch label="Show avatar playground" preference={playground} />,
        },
      ]}
    />
  );
}
