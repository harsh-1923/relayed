// Applies the theme preference to the document (PREFERENCES.md §9).
//
// WHY THIS EXISTS AT ALL, because the obvious version was tried and is wrong.
// `main.tsx` used to own the whole job: one MediaQueryList, an initial paint,
// and a `change` listener. That is correct for the machine changing its own
// appearance, and it does NOT work for a preference — measured on Electron 44,
// six forced transitions with 2.5s between them:
//
//   nativeTheme.themeSource = 'light'   matchMedia(...).matches → false  ✓
//                                       'change' listeners fired → 0     ✗
//
// `matches` updates; the event is never delivered. So a window told to go light
// reported light to anything that asked, and went on rendering dark, for ever —
// no error, and a toggle that writes its preference correctly and appears to do
// nothing. The listener stays for the system case, which is a real media change
// and is what it was written for.
//
// The class is therefore derived from the PREFERENCE, and only the `system`
// case asks the machine. That is not a second authority over the theme: main
// sets `nativeTheme.themeSource` from the same stored value, so the native
// window material and these tokens are two readings of one fact rather than
// two facts. `prefs.set` waits for main before it invalidates, so by the time
// this sees a new value the window underneath it has already moved.
import { useEffect } from 'react';
import { usePreference } from '@/lib/prefs';

export function Theme(): null {
  const { value } = usePreference('appearance.theme');

  useEffect(() => {
    const machine = window.matchMedia('(prefers-color-scheme: dark)');
    const paint = (): void => {
      document.documentElement.classList.toggle(
        'dark', value === 'dark' || (value === 'system' && machine.matches),
      );
    };
    paint();

    // Only `system` follows the machine. Left attached for the other two, a
    // change of OS appearance would quietly undo an explicit choice.
    if (value !== 'system') return;
    machine.addEventListener('change', paint);
    return () => { machine.removeEventListener('change', paint); };
  }, [value]);

  return null;
}
