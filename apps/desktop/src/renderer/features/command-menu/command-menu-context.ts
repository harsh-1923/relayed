// What a source may ask of the open menu, and the one shape of a row in it.
import { createContext, useContext, type ComponentType } from 'react';

/**
 * One row, whatever it does. Opening a place and running a command differ only
 * in `perform`, so every source renders through the same row and the menu never
 * learns what a source contains.
 */
export interface CommandMenuItem {
  /** Unique across every source: cmdk's value for the row. Prefix it with the source. */
  readonly id: string;
  readonly label: string;
  readonly icon?: ComponentType<{ className?: string }>;
  /** The human words the row is found by. The id is never searched. */
  readonly keywords: readonly string[];
  /** Tells apart rows whose labels are the same, such as a folder. */
  readonly detail?: string | null;
  readonly shortcut?: string | null;
  readonly disabled?: boolean;
  /** Runs once the menu has closed and handed focus back. */
  readonly perform: () => void;
}

export interface CommandMenuApi {
  /** Close the menu, then perform. */
  run(perform: () => void): void;
}

export const CommandMenuContext = createContext<CommandMenuApi | null>(null);

export function useCommandMenu(): CommandMenuApi {
  const api = useContext(CommandMenuContext);
  if (!api) throw new Error('command menu source outside CommandMenu');
  return api;
}
