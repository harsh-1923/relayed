// The app icon's colorway, as a grid of swatches (PREFERENCES.md §9).
//
// The second writer the preferences table has, and it follows the first
// exactly: NOTHING HERE APPLIES THE ICON. `prefs.set` stores the id, the sync
// engine tells main, and main composites the picture and calls
// `app.dock.setIcon` (main/app-icon.ts). Painting it here as well would be a
// second implementation of the same gradient, and two of those drift — which
// is the whole reason the colour table is in `shared/`.
//
// The swatch is not the icon, though: it is a CSS plate behind the real mark.
// A rounded rectangle stands in for the icon's squircle, which is a difference
// nobody can see at 40px and which avoids carrying a second copy of that path.
import { CheckTickSingle } from '@relayed/icons';
import { cn } from 'cn';
import { AppIconMark } from '@/components/AppIconMark';
import { usePreference } from '@/lib/prefs';
import { colorwayBackground, ICON_COLORWAYS } from '../../../shared/icon-colorways.ts';

export function IconColorwayPicker() {
  const icon = usePreference('appearance.icon');

  // The same three reasons the theme control refuses a click, and only the
  // middle one is transient: the value on screen is still the default until
  // the first read lands, a write is already in flight, or there is no account
  // to store it in — which Account Settings renders without (PREFERENCES.md §4).
  const disabled = !icon.loaded || icon.saving || !icon.writable;

  return (
    <div
      role="radiogroup"
      aria-label="App icon"
      title={icon.writable ? undefined : 'Sign in to change the app icon'}
      className={cn(
        'grid w-full grid-cols-4 gap-x-3 gap-y-4 sm:grid-cols-6',
        disabled && 'opacity-60',
      )}
    >
      {ICON_COLORWAYS.map((colorway) => {
        const selected = colorway.id === icon.value;
        return (
          <button
            key={colorway.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={colorway.name}
            disabled={disabled}
            // Re-picking the current colorway is a no-op rather than a write:
            // the row is already that value, and storing it again would wake
            // every preference reader for nothing.
            onClick={() => { if (!selected) icon.set(colorway.id); }}
            className="group flex flex-col items-center gap-1.5 rounded-md outline-none disabled:cursor-default"
          >
            <span
              className={cn(
                'relative flex size-10 items-center justify-center rounded-[22%] shadow-sm',
                'ring-offset-2 ring-offset-background transition-transform',
                selected && 'ring-2 ring-ring',
                !disabled && !selected && 'group-hover:-translate-y-0.5',
                'group-focus-visible:ring-2 group-focus-visible:ring-ring',
              )}
              // Inline, because these are data rather than design tokens —
              // there is no Tailwind class for a colour the catalogue owns.
              style={{ background: colorwayBackground(colorway), color: colorway.fg }}
            >
              <AppIconMark className="size-[44%]" />
              {selected && (
                <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                  <CheckTickSingle className="size-2.5" />
                </span>
              )}
            </span>
            <span className={cn(
              'text-[11px] leading-none',
              selected ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}>
              {colorway.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
