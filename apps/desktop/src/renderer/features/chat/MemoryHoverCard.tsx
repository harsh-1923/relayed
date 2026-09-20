// What a reply was handed from memory, and what it drew on — on hover, beside
// the copy button (docs/MEMORY.md §7.2).
//
// A FOOTER AFFORDANCE, NOT A BLOCK IN THE REPLY. Provenance is something a
// reader reaches for when they doubt an answer, not something that should sit
// under every answer competing with it. An inline card pushed the reply up the
// screen and made a six-line recall louder than the two-line answer it
// produced.
//
// THE SERVER BUILT THIS PART, from the facts it injected marked with the
// citations the reply kept — so it is trusted the way a `tool` part is, and for
// the same reason: a model writes text, never parts
// (docs/AGENT-RESPONSES.md, who controls each part).
//
// BOTH HALVES WHILE THIS IS BEING BUILT. Seeing what was recalled and ignored
// is the fastest way to tell a bad recall from a model that did not need one.
// Once `memory.facts.cited` exists (MEMORY.md §14.6) the unused ones become
// noise and this should show the cited ones only.
import type { MemoryPart } from '@relayed/protocol';
import { Notebook } from '@relayed/icons';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';
import { MarkdownText } from './MarkdownText';

/** Long enough that moving the pointer across the footer opens nothing. */
const OPEN_DELAY_MS = 300;

export function MemoryHoverCard({ part, onOpenLink }: {
  part: MemoryPart;
  onOpenLink?: (href: string) => void;
}) {
  const cited = part.recalled.filter(memory => memory.used);

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={OPEN_DELAY_MS}
        render={
          <button
            type="button"
            // Said out loud: the icon alone does not tell a screen reader
            // whether this reply leaned on anything.
            aria-label={cited.length > 0
              ? `Memory: ${cited.length} of ${part.recalled.length} recalled facts cited`
              : `Memory: ${part.recalled.length} recalled, none cited`}
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded transition-colors',
              'hover:bg-muted hover:text-foreground',
              // A reply that USED memory says so at rest; one that merely had
              // some offered stays quiet until the footer is hovered, like the
              // copy button beside it.
              cited.length > 0
                ? 'text-muted-foreground'
                : 'text-muted-foreground/60 opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100',
            )}
          />
        }
      >
        <Notebook className="size-3" />
      </HoverCardTrigger>

      {/*
        TO THE SIDE, not above. A card over the conversation covers the thing it
        is explaining; beside it, the reply and its provenance are readable at
        once. `align="start"` lines its top edge up with the footer it came
        from, so the eye travels sideways rather than hunting.
        
        Wide enough for a fact to be a sentence rather than four short lines —
        these are whole clauses with a citation after them, and at 320px most
        of them wrapped three times. Bounded on both axes: `max-w` keeps it
        inside a narrow window (the positioner will flip it, never shrink it),
        and the list below caps the height.
      */}
      <HoverCardContent side="right" align="start" className="w-[26rem] max-w-[calc(100vw-2rem)] p-3.5">
        <p className="mb-2.5 text-xs font-medium text-foreground">
          {cited.length > 0 ? 'Memories cited' : 'Recalled, none used'}
          {part.recalled.length > cited.length && (
            <span className="ml-1 font-normal text-muted-foreground">
              {cited.length} of {part.recalled.length}
            </span>
          )}
        </p>

        {/*
          The HEADING stays put and the list scrolls under it, so the count is
          still readable at the bottom of a long recall. `overscroll-contain`
          stops a flick at the end of the list scrolling the chat behind it —
          which, with the card overlapping the message, reads as the whole view
          jumping.
        */}
        <ul className="flex max-h-72 list-disc flex-col gap-2.5 overflow-y-auto overscroll-contain pr-1.5 pl-4 text-xs leading-relaxed marker:text-border">
          {part.recalled.map(memory => (
            <li
              key={memory.message_id}
              // Cited facts are the reply's sources; the rest were offered and
              // passed over. Kept in the order the server sent them, which is
              // strongest match first.
              className={cn(memory.used ? 'text-muted-foreground' : 'text-muted-foreground/55')}
            >
              {/*
                Through MarkdownText so the citation behaves exactly like one
                written inline in a reply: the `message:` link form and its
                click handling already exist, and a second implementation of
                "go to that message" would be a second thing to keep true.
              */}
              <MarkdownText
                text={`${memory.text} — [${memory.label}](message:${memory.message_id})`}
                onOpenLink={onOpenLink}
              />
            </li>
          ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  );
}
