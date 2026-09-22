import { useSession } from '@/app/state';
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
  const { state } = useSession();

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
        {
          label: 'Local replica',
          description: 'What is open on this device: renderer → MessagePort → utilityProcess → SQLite.',
          layout: 'stacked',
          value: (
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1 font-mono text-xs text-muted-foreground">
              <dt>install</dt><dd className="truncate">{state.installId}</dd>
              <dt>account</dt><dd className="truncate">{state.accountId ?? '—'}</dd>
              <dt>accounts</dt><dd>{state.accounts.length} on this device</dd>
              <dt>workspace</dt><dd className="truncate">{state.workspaceId ?? '—'}</dd>
              <dt>replicas</dt><dd>{state.workspaces.filter(w => w.state === 'active').length} known</dd>
              {/* Device-tier and monotonic, so it survives a sign-out. It reset
                  to 0 once, when it lived in account.db, and every reply after
                  that looked stale (STORAGE.md §8). */}
              <dt>epoch</dt><dd>{state.epoch}</dd>
            </dl>
          ),
        },
      ]}
    />
  );
}
