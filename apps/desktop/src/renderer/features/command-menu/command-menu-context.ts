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

/**
 * One group of rows, and one tab above them. A source declares its sections as
 * a constant so the strip can be ordered without waiting for anything to load;
 * whether a section is offered at all is reported at render time by its group.
 */
export interface CommandMenuSection {
  readonly id: string;
  readonly label: string;
}

export interface CommandMenuApi {
  /** Close the menu, then perform. */
  run(perform: () => void): void;
  /**
   * A group reports itself while it holds rows, so a tab is only offered for a
   * section there is something to see in. Stable across renders: groups call it
   * from an effect.
   */
  reportRows(section: string, hasRows: boolean): void;
}

export const CommandMenuContext = createContext<CommandMenuApi | null>(null);

/**
 * The section the tabs have narrowed to, or null for all of them. Apart from
 * the api so that switching tabs does not re-run every group's reporting.
 */
export const CommandMenuSectionContext = createContext<string | null>(null);

export function useCommandMenu(): CommandMenuApi {
  const api = useContext(CommandMenuContext);
  if (!api) throw new Error('command menu source outside CommandMenu');
  return api;
}

export function useActiveSection(): string | null {
  return useContext(CommandMenuSectionContext);
}
