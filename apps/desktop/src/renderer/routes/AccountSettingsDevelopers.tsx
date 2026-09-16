import { SettingsPanel } from '@/features/settings/SettingsPanel';
import { Switch } from '@/components/ui/switch';
import { usePreference } from '@/lib/prefs';

export function AccountSettingsDevelopers() {
  const routeStrip = usePreference('developer.route_strip.visible');
  const disabled = !routeStrip.loaded || routeStrip.saving || !routeStrip.writable;

  return (
    <SettingsPanel
      title="Developers"
      description="Tools for inspecting what Relayed is doing on this device."
      items={[{
        label: 'Route strip',
        description: 'Show the current route and panel query in the top bar.',
        value: (
          <span title={routeStrip.writable ? undefined : 'Sign in to change developer settings'}>
            <Switch
              aria-label="Show route strip"
              checked={routeStrip.value}
              disabled={disabled}
              onCheckedChange={routeStrip.set}
            />
          </span>
        ),
      }]}
    />
  );
}
