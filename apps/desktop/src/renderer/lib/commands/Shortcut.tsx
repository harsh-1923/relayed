// A binding rendered as keys (SHORTCUTS.md §13.3). The one visual spelling of a
// shortcut: never hand-write `⌘K` in a label.
//
// Given a command, it shows that command's primary effective binding and so
// follows a remap; given a hotkey, it shows exactly that chord.
import { ariaChord, displayChord, type Platform } from '../../../shared/shortcuts/tanstack-driver.ts';
import type { CommandId } from '../../../shared/shortcuts/catalogue.ts';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import { useCommandBindings } from './CommandProvider';

/** `⌘ ⇧ P` separates with spaces on macOS; `Ctrl+Shift+P` with plus signs elsewhere. */
function keysOf(hotkey: string, platform: Platform): string[] {
  const display = displayChord(hotkey, platform);
  return platform === 'mac' ? display.split(' ') : display.split(/\+(?=.)/);
}

export function Shortcut({
  command, hotkey, className,
}: {
  command?: CommandId;
  hotkey?: string;
  className?: string;
}) {
  const { platform, effective } = useCommandBindings();
  const chord = hotkey ?? effective.find(binding => binding.id === command)?.hotkeys[0];
  if (chord === undefined) return null;
  return (
    <KbdGroup aria-label={ariaChord(chord, platform)} data-shortcut={chord} className={cn(className)}>
      {keysOf(chord, platform).map((key, index) => (
        <Kbd key={index} aria-hidden="true">{key}</Kbd>
      ))}
    </KbdGroup>
  );
}
