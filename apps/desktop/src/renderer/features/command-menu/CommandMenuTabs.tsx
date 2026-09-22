// The strip under the input: narrow the results to one section without typing
// a word for it.
//
// Only sections that currently hold rows are offered, so a workspace with no
// group messages has no tab leading to none. "All" is always first and is the
// state the menu opens in.
import { cn } from 'cn';
import type { CommandMenuSection } from './command-menu-context.ts';

export function CommandMenuTabs({
  sections, active, onSelect,
}: {
  readonly sections: readonly CommandMenuSection[];
  readonly active: string | null;
  onSelect(section: string | null): void;
}) {
  if (sections.length === 0) return null;
  return (
    <div
      role="tablist"
      aria-label="Result sections"
      className="-mx-1 flex shrink-0 items-center gap-1 overflow-x-auto border-b px-3 py-2"
    >
      <Tab label="All" selected={active === null} onSelect={() => onSelect(null)} />
      {sections.map(section => (
        <Tab
          key={section.id}
          label={section.label}
          selected={active === section.id}
          onSelect={() => onSelect(section.id)}
        />
      ))}
    </div>
  );
}

function Tab({
  label, selected, onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      // Tab switches tabs (CommandMenu), so the strip is not itself a tab stop.
      tabIndex={-1}
      // The input keeps focus: clicking a tab narrows what is listed, it does
      // not stop you typing, and cmdk only reads keys from the input.
      onMouseDown={event => event.preventDefault()}
      onClick={onSelect}
      className={cn(
        'shrink-0 rounded-md px-2.5 py-1 text-sm whitespace-nowrap transition-colors',
        selected
          ? 'bg-muted font-medium text-foreground'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}
