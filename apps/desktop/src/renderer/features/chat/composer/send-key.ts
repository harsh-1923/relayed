// Whether a key press in the composer sends (COMPOSER.md, Return; SHORTCUTS.md §10).
//
// The composer's own capture-phase handler still decides — it has to run
// before ProseMirror inserts a paragraph and after a suggestion menu has had
// the key — but the chords come from the command bus, so a person's binding for
// `composer.message.send` is what sends. Pure, so every rule runs under
// `node --test`.
import { chordFromKeydown, parseChord, type KeydownLike, type Platform } from '../../../../shared/shortcuts/tanstack-driver.ts';

export interface SendKeyContext {
  readonly platform: Platform;
  /** `composer.message.send`'s effective bindings. Empty when disabled. */
  readonly hotkeys: readonly string[];
  /** A mention or command menu is open and owns Return. */
  readonly suggestionOpen: boolean;
  /** The selection is inside a code block. */
  readonly inCodeBlock: boolean;
}

export function isSendKey(
  event: KeydownLike & { readonly isComposing: boolean; readonly keyCode: number },
  context: SendKeyContext,
): boolean {
  // Composition first: an IME's Return confirms a candidate, it never sends.
  if (event.isComposing || event.keyCode === 229) return false;
  // Then the menu: Return accepts a suggestion while one is open.
  if (context.suggestionOpen) return false;
  const chord = chordFromKeydown(event, context.platform);
  if (!context.hotkeys.includes(chord)) return false;
  // A binding without Control, Alt or Command is a multiline Return inside a
  // code block; a modified binding sends from every block.
  const parsed = parseChord(chord, context.platform);
  const modified = parsed.ctrl || parsed.alt || parsed.meta;
  return modified || !context.inCodeBlock;
}
