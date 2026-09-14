// The keyboard adapter's decision, as a pure function (SHORTCUTS.md §8.2).
//
// Separated from the listener so every guard runs under `node --test` against
// the real registry and the real binding index. The provider reads the DOM
// facts — editable focus, AltGraph — and passes them in.
import { definitionOf, type CommandId } from '../../../shared/shortcuts/catalogue.ts';
import type { EffectiveBinding } from '../../../shared/shortcuts/resolve.ts';
import {
  chordFromKeydown, physicalChordFromKeydown, type KeydownLike, type Platform,
} from '../../../shared/shortcuts/tanstack-driver.ts';
import type { CommandRegistry, HandlerRegistration } from './registry.ts';

export interface KeydownFacts extends KeydownLike {
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
  readonly defaultPrevented: boolean;
  /** `event.getModifierState('AltGraph')`. */
  readonly altGraph: boolean;
  /** Whether focus, along the composed path, is a text-entry control. */
  readonly editable: boolean;
}

export interface BindingIndex {
  readonly logical: ReadonlyMap<string, CommandId>;
  readonly physical: ReadonlyMap<string, CommandId>;
}

export function buildIndex(effective: readonly EffectiveBinding[]): BindingIndex {
  const logical = new Map<string, CommandId>();
  const physical = new Map<string, CommandId>();
  for (const binding of effective) {
    // Only ambient and overlay commands are the document adapter's to
    // dispatch. A `focused-editor` command belongs to its editor's own keymap
    // (§12.3) — the composer's capture-phase send path, today.
    if (definitionOf(binding.id).inputPolicy === 'focused-editor') continue;
    const index = definitionOf(binding.id).keyMatch === 'physical' ? physical : logical;
    for (const hotkey of binding.hotkeys) {
      // The catalogue test forbids a default hard conflict and the sync engine
      // will refuse a stored one, so a collision here is a shadow between
      // layers. The index keeps the first; the registry, not the index, decides
      // precedence once shadows are dispatchable.
      if (!index.has(hotkey)) index.set(hotkey, binding.id);
    }
  }
  return { logical, physical };
}

export type Decision =
  | { readonly kind: 'run'; readonly id: CommandId; readonly handler: HandlerRegistration }
  | { readonly kind: 'skip'; readonly reason: SkipReason; readonly id?: CommandId };

export type SkipReason =
  | 'default-prevented'
  | 'composing'
  | 'altgraph'
  | 'unbound'
  | 'repeat'
  | 'editable'
  | 'disabled'
  | 'unavailable'
  | 'ambiguous';

/**
 * Every guard in the order the dispatch algorithm lists them. Nothing here
 * prevents a default: a skip leaves the event untouched for the browser, the
 * editor or the OS, and only a `run` lets the provider call `preventDefault`.
 */
export function decide(
  event: KeydownFacts, platform: Platform, index: BindingIndex, registry: CommandRegistry,
): Decision {
  if (event.defaultPrevented) return { kind: 'skip', reason: 'default-prevented' };
  // 229 is what Chromium reports for a keydown that an IME is consuming.
  if (event.isComposing || event.keyCode === 229) return { kind: 'skip', reason: 'composing' };
  const logicalId = index.logical.get(chordFromKeydown(event, platform));
  const physicalChord = physicalChordFromKeydown(event, platform);
  const physicalId = physicalChord ? index.physical.get(physicalChord) : undefined;
  const id = logicalId ?? physicalId;
  // macOS Option may report as AltGraph. Only an explicitly physical binding
  // may claim that chord; Control+Alt text entry elsewhere remains untouched.
  if (event.altGraph && physicalId === undefined) return { kind: 'skip', reason: 'altgraph' };
  if (id === undefined) return { kind: 'skip', reason: 'unbound' };
  const definition = definitionOf(id);
  if (event.repeat && definition.repeat !== 'allow') return { kind: 'skip', reason: 'repeat', id };
  if (definition.inputPolicy === 'deny-editable' && event.editable) return { kind: 'skip', reason: 'editable', id };
  const resolution = registry.resolve(id);
  if (resolution.kind === 'winner') return { kind: 'run', id, handler: resolution.handler };
  return { kind: 'skip', reason: resolution.kind, id };
}
