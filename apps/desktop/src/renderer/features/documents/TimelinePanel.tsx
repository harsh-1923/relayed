// A room's timeline (docs/MEMORY.md §14): how this room has progressed, one
// entry per finished conversation.
//
// A PROJECTION, READ ENTIRELY FROM THE REPLICA. No Hindsight call, no network,
// works offline — which is the whole reason the entries are rows we replicate
// rather than a view we fetch.
//
// HISTORICAL, and that is what makes it different from the summary above it.
// An entry describes a stretch of time that has already happened and is never
// regenerated, so nothing here changes retroactively. The summary restates
// current state and is rewritten; these do not compete.
import { useQuery } from '@/lib/query';
import { ActorAvatar } from '@/components/ActorAvatar';
import { MarkdownText } from '../chat/MarkdownText';
import { Marker, MarkerContent } from '@/components/ui/marker';
import { byDay, messageCount, visibleEntries, type TimelineEntry } from '../../../shared/timeline.ts';
import { cn } from '@/lib/utils';

/** Faces beyond this become "+n": a busy episode must not become a wall of avatars. */
const FACES = 3;

export function TimelinePanel({ spaceId }: { spaceId: string }) {
  const { rows } = useQuery('timeline.list', { spaceId });

  // NULL until the first read completes, and never null to mean empty
  // (`QueryResult`). Telling them apart is the difference between "loading" and
  // "this room has no timeline", which are not the same sentence.
  if (rows === null) return <Empty>Loading the timeline…</Empty>;

  const entries = visibleEntries(rows);
  if (entries.length === 0) {
    // Three different nothings, and only one of them is a problem — but the
    // panel cannot tell them apart from here (memory off for this room, memory
    // on and nothing said yet, memory on and extraction finding nothing), so
    // it says the one true thing rather than guessing.
    return (
      <Empty>
        Nothing yet — a room’s timeline fills in as conversations here finish.
      </Empty>
    );
  }

  return (
    // A NAMED CONTAINER, and a container query rather than a breakpoint: this
    // panel is resized by dragging the split beside the chat, so the window's
    // width says nothing about it — it can be 380px wide on a 2560px monitor.
    // Named so the entries query THIS element rather than whatever container
    // happens to be nearest once this panel is nested somewhere else.
    //
    // The gutter is one of the two things a cramped panel can give back to the
    // prose; the time column below is the other.
    <div className="@container/timeline min-h-0 flex-1 overflow-y-auto px-5 @min-[30rem]/timeline:px-8">
      {/*
        NO PADDING ABOVE THE FIRST MARKER, so it opens already in the position
        it sticks at and never moves. Anything here — on the scroller or on
        this element — would make the first day slide up 24px on the first
        scroll and then stop, which reads as a jolt for no reason. The marker's
        own `pt-3` is the air at the top, and being part of its painted box it
        is there at rest and still there stuck.

        Bottom padding only, and on THIS element rather than the scroller: a
        sticky child sticks to the SCROLLPORT — the scroll container's padding
        box — so padding there would park the marker below the top edge and
        leave a strip above it for entries to scroll through in full view.
      */}
      <div className="mx-auto w-full max-w-[72ch] pb-6">
        {byDay(entries).map(({ day, entries: ofDay }) => (
          <section key={day} className="mb-4">
            {/*
              The SAME marker the chat draws a day change with, so a day break
              reads the same in both places — hairlines either side of the
              label rather than a heading above a list. A reader scrolling a
              room's history should not have to learn two vocabularies for
              "this is a different day".

              Sticky, which the chat's markers are not: a timeline is read by
              scanning rather than by following, and the day you are looking at
              should not leave the screen while you are still in it.
            */}
            <Marker
              variant="separator"
              render={<h3 />}
              // EVERY PIXEL OF THE GAP IS PADDING, and the background is fully
              // opaque. Both halves are the fix for the same thing: a sticky
              // header only hides what passes UNDER ITS OWN PAINTED BOX, so a
              // `mb-4` left a 16px transparent band that scrolling entries slid
              // through — a half-cut line of text hanging below the date. And
              // `bg-background/95` let the rest ghost through at 5%.
              //
              // No `backdrop-blur` either: there is nothing to blur behind an
              // opaque layer, and it was paying for a filter that did nothing.
              className="sticky top-0 z-10 bg-background pt-5 pb-7 text-xs"
            >
              <MarkerContent className="font-medium">{dayLabel(day)}</MarkerContent>
            </Marker>
            <ol>
              {ofDay.map(entry => <Entry key={entry.id} entry={entry} />)}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

function Entry({ entry }: { entry: TimelineEntry }) {
  return (
    // NARROW FIRST, widening at 30rem — the mobile-first rule, applied to a
    // container instead of the viewport.
    //
    //   narrow          wide
    //   [●] [ 15:58 ]   [ 15:58 ] [●] [ title  ]
    //   [●] [ title  ]
    //
    // `col-start`/`row-start` rather than `grid-template-areas`: the areas
    // version reads better as CSS but has no utility, and a second stylesheet
    // for two lines of layout is a second place to look.
    <li className="group/entry relative grid grid-cols-[0.75rem_minmax(0,1fr)] gap-x-3 pb-14 @min-[30rem]/timeline:grid-cols-[3rem_0.75rem_minmax(0,1fr)]">
      {/*
        ONE `time` element, which the grid MOVES — beside the entry when there
        is room, above its title when there is not. Rendering it twice and
        hiding one would read it twice to a screen reader and leave two places
        to keep true.
      */}
      <time
        className={cn(
          'col-start-2 row-start-1 mb-0.5 pt-px text-xs tabular-nums text-muted-foreground',
          '@min-[30rem]/timeline:col-start-1 @min-[30rem]/timeline:mb-0 @min-[30rem]/timeline:text-right',
        )}
        dateTime={new Date(entry.occurredStart).toISOString()}
      >
        {clock(entry.occurredStart)}
      </time>

      {/* Spanning both rows while narrow, so the line stays continuous down the
          left rather than restarting per row. It is still a timeline, drawn
          narrower. */}
      <div className="relative col-start-1 row-start-1 row-span-2 flex justify-center @min-[30rem]/timeline:col-start-2 @min-[30rem]/timeline:row-span-1">
        {/* Down past this entry's own padding to the next dot — so `-bottom-14`
            tracks `pb-14` above, and the last entry draws no trailing line. */}
        <span aria-hidden className="absolute top-3 -bottom-14 w-px bg-border group-last/entry:hidden" />
        <span
          aria-hidden
          className={cn(
            'relative mt-1 rounded-full bg-muted-foreground/40 ring-3 ring-background',
            // How much was established, as weight. Three steps rather than a
            // continuous scale: the eye reads "bigger" and not "1.4× bigger",
            // and `significance` is breadth only today (§14.5).
            weight(entry.significance),
          )}
        />
      </div>

      <div className="col-start-2 row-start-2 min-w-0 @min-[30rem]/timeline:col-start-3 @min-[30rem]/timeline:row-start-1">
        <h4 className="text-sm font-medium text-foreground">{entry.title}</h4>

        {/*
          THROUGH MARKDOWN, so a person named in the prose is the chip they are
          everywhere else in the app: hover for their card, and no second
          implementation of what a mention looks like. The narrator writes them
          as `actor-ref`, which draws the name and face and notifies nobody —
          this is a record of a conversation that finished, and nobody should
          be pinged days later for having been in one.
        */}
        {entry.summary
          ? (
            <div className="mt-1 text-muted-foreground">
              <MarkdownText text={entry.summary} className="markdown-compact" />
            </div>
          )
          /* Narration could not run, or had one fact and nothing to say with
             it. The facts are what the entry was built from, so they are what
             it falls back to — visibly plainer, never absent. They come from
             extraction and carry plain names, not chips. */
          : (
            <ul className="mt-1 list-disc pl-4 text-sm leading-relaxed text-muted-foreground marker:text-border">
              {entry.facts.map((fact, index) => <li key={index}>{fact.text}</li>)}
            </ul>
          )}

        {/* The faces sit UNDER the entry, where the eye reaches them after
            reading it — not beside the title competing with it. */}
        <div className="mt-2 flex items-center gap-2">
          <Faces ids={entry.participants} />
          <p className="text-xs text-muted-foreground/70">
            {messageCount(entry)} message{messageCount(entry) === 1 ? '' : 's'}
            {/* Only when there is prose above: otherwise the facts ARE the body
                and repeating their count under them says nothing. */}
            {entry.summary && entry.facts.length > 0 && (
              <> · {entry.facts.length} thing{entry.facts.length === 1 ? '' : 's'} remembered</>
            )}
          </p>
        </div>
      </div>
    </li>
  );
}

/** Who was in it. Ids only — the directory already holds the faces. */
function Faces({ ids }: { ids: readonly string[] }) {
  if (ids.length === 0) return null;
  const shown = ids.slice(0, FACES);
  return (
    <span className="flex shrink-0 items-center -space-x-1">
      {shown.map(id => (
        <ActorAvatar
          key={id}
          id={id}
          className="size-4.5 ring-2 ring-background"
          fallbackClassName="text-[8px]"
          profileOnHover
        />
      ))}
      {ids.length > shown.length && (
        <span className="flex size-4.5 items-center justify-center rounded-full bg-muted text-[8px] font-medium text-muted-foreground ring-2 ring-background">
          +{ids.length - shown.length}
        </span>
      )}
    </span>
  );
}

const weight = (significance: number): string =>
  significance >= 5 ? 'size-2.5' : significance >= 3 ? 'size-2' : 'size-1.5';

const clock = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * `Today`, `Yesterday`, or the date — compared on the calendar day rather than
 * on elapsed hours, so 00:30 reads as today and not as "9 hours ago".
 */
function dayLabel(day: number): string {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.round((midnight.getTime() - day) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(day).toLocaleDateString([], {
    weekday: 'short', day: 'numeric', month: 'short',
    ...(days > 300 ? { year: 'numeric' } : {}),
  });
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-10">
      <p className="max-w-[40ch] text-center text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
