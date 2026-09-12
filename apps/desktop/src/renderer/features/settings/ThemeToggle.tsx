// The theme preference, as a segmented control (PREFERENCES.md §9).
//
// The FIRST WRITER the preferences table has. Everything under it — the shared
// catalogue, the account-tier row, the invalidation — was built for this one
// key, and deliberately with one key rather than several: a table whose
// constraints nothing has exercised is the shape this codebase has agreed not
// to ship.
//
// Nothing here applies the theme. `prefs.set` tells main, main sets
// `nativeTheme.themeSource`, Chromium re-evaluates `prefers-color-scheme`, and
// the listener `main.tsx` has had since the window learned to follow the system
// toggles `html.dark`. Doing it here instead would move the CSS tokens and
// leave the native window material behind — a dark interface in a light-
// material window, which is the failure the single source of truth prevents.
import { Monitor01, Moon, Sun } from '@relayed/icons';
import { usePreference } from '@/lib/prefs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { ThemePreference } from '../../../shared/prefs.ts';

const CHOICES: { value: ThemePreference; label: string; Icon: typeof Monitor01 }[] = [
  { value: 'system', label: 'System', Icon: Monitor01 },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

export function ThemeToggle() {
  const theme = usePreference('appearance.theme');

  // SIGNED OUT IS A REAL STATE HERE, not a corner case: Account Settings has no
  // guard on it, so this screen renders before there is an account.db to write
  // to (PREFERENCES.md §4). The title is on the wrapper rather than the buttons
  // because a disabled button does not reliably fire the hover that shows one.
  return (
    <span title={theme.writable ? undefined : 'Sign in to change the theme'}>
    <ToggleGroup
      value={[theme.value]}
      // THE EMPTY ARRAY IS NOT A CHOICE. A single-select toggle group still
      // deselects when its pressed item is clicked again, which would leave the
      // control showing nothing and the theme unwritten — so a change that
      // clears the selection is dropped rather than stored. Re-clicking the
      // current theme is then a no-op, which is what somebody doing it means.
      onValueChange={(next) => {
        const [chosen] = next as ThemePreference[];
        if (chosen && chosen !== theme.value) theme.set(chosen);
      }}
      // Three reasons to refuse a click, and only one of them is transient.
      // Until the first read lands the value shown is the DEFAULT rather than
      // what is stored, so the control must not resolve a click against the
      // wrong current value; a write is already in flight; or there is no
      // account to store it in, which the wrapper above explains.
      disabled={!theme.loaded || theme.saving || !theme.writable}
      variant="outline"
      size="sm"
      spacing={0}
      aria-label="Theme"
    >
      {CHOICES.map(({ value, label, Icon }) => (
        <ToggleGroupItem key={value} value={value} aria-label={label}>
          <Icon data-icon="inline-start" />
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
    </span>
  );
}
