// Tools the agent really ran, as quiet one-line markers.
//
// The runtime writes these parts from what happened, not from what the model
// said happened, so they are trusted in a way a `ui` part is not
// (docs/AGENT-RESPONSES.md, who controls each part). A turn can run a hundred
// tools and the reply is what a reader came for, so a run of consecutive tools
// is ONE muted line; opened, each call is a line of its own — a verb and what
// it touched — whose input and output open underneath only when asked.
import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion';
import type { ToolPart } from '@relayed/protocol';
import { summariseTool } from '@relayed/genui';
import {
  AlertTriangle, Bot, ChevronRight, EarthGlobe, FileSearch, FileText, ListCheck,
  PencilEdit, SearchDefault, TerminalConsoleSquare, Tools,
} from '@relayed/icons';
import { Accordion, AccordionContent, AccordionItem } from '@/components/ui/accordion';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';

type Icon = typeof Tools;

/** How Claude Code's own tools read in a sentence. Anything else keeps its name. */
const TOOLS: Record<string, { verb: string; icon: Icon }> = {
  Read: { verb: 'Read', icon: FileText },
  Write: { verb: 'Wrote', icon: PencilEdit },
  Edit: { verb: 'Edited', icon: PencilEdit },
  MultiEdit: { verb: 'Edited', icon: PencilEdit },
  NotebookEdit: { verb: 'Edited', icon: PencilEdit },
  Bash: { verb: 'Ran', icon: TerminalConsoleSquare },
  Grep: { verb: 'Searched for', icon: SearchDefault },
  Glob: { verb: 'Listed', icon: FileSearch },
  WebFetch: { verb: 'Fetched', icon: EarthGlobe },
  WebSearch: { verb: 'Searched the web for', icon: EarthGlobe },
  Task: { verb: 'Agent', icon: Bot },
  Agent: { verb: 'Agent', icon: Bot },
  TodoWrite: { verb: 'Updated the plan', icon: ListCheck },
};

function describe(name: string): { verb: string; icon: Icon } {
  // MCP tools arrive as `mcp__<server>__<tool>`; the tool is the readable half.
  const mcp = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  return TOOLS[name] ?? { verb: (mcp?.[1] ?? name).replaceAll('_', ' '), icon: Tools };
}

const duration = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * Consecutive tool parts, folded into one line.
 *
 * While any of them runs, the line is the latest tool — what Claude is doing
 * now — shimmering. Once all have reported back it is a count. Opening it
 * lists every call, each of which opens to its input and output.
 * `running(part)`: still being written and not yet reported back.
 */
export function ToolCalls({ parts, running }: { parts: readonly ToolPart[]; running: (part: ToolPart) => boolean }) {
  const list = (
    <Accordion multiple className="gap-1">
      {parts.map(part => <ToolCall key={part.tool_use_id} part={part} running={running(part)} />)}
    </Accordion>
  );
  const failures = parts.filter(part => !running(part) && !part.ok).length;
  // The newest call still going: calls can report back out of order when
  // Claude runs several at once. Held on screen for a beat — see useSteady.
  const current = parts.findLast(running) ?? null;
  const shown = useSteady(current, parts.length);
  const busy = shown !== null;

  // One call has nothing to fold.
  if (parts.length === 1) return list;

  return (
    <Collapsible>
      <CollapsibleTrigger
        render={<Marker />}
        className="group/tools cursor-pointer rounded-md py-0.5 transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {busy ? (
          <span key={shown.tool_use_id} className="flex min-w-0 items-center gap-2 animate-in duration-300 fade-in slide-in-from-bottom-1">
            <ToolLine part={shown} running />
          </span>
        ) : (
          <>
            <MarkerIcon className="flex items-center justify-center">
              {failures > 0
                ? <AlertTriangle className="size-3.5 text-destructive" aria-label="some failed" />
                : <Tools className="size-3.5" />}
            </MarkerIcon>
            <MarkerContent className="flex min-w-0 items-baseline gap-1.5 animate-in duration-300 fade-in">
              <span>{parts.length} tools called</span>
              {failures > 0 && <span className="text-xs text-destructive">{failures} failed</span>}
            </MarkerContent>
          </>
        )}
        <ChevronRight className="-ml-0.5 size-3.5 shrink-0 opacity-0 transition group-hover/tools:opacity-70 group-data-[panel-open]/tools:rotate-90 group-data-[panel-open]/tools:opacity-70" />
        {busy && <span className="ml-auto shrink-0 text-xs tabular-nums opacity-70">{parts.length} calls</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 ml-2 border-l border-border pl-3">{list}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const basename = (path: string): string => path.replace(/\/+$/, '').split('/').at(-1) || path;

const field = (input: unknown, key: string): string | null => {
  const value = (input as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/**
 * What a marker names, shorter than the generic summary: on a one-line marker
 * directories are noise, and for a search the TERM is the point, not where it
 * looked. `full` is the long form, one hover away.
 */
function markerSummary(part: ToolPart): { summary: string; full: string } {
  const generic = summariseTool(part.input);
  const path = field(part.input, 'path');
  const pattern = field(part.input, 'pattern');
  const query = field(part.input, 'query');
  switch (part.name) {
    case 'Read':
      return { summary: basename(generic), full: generic };
    case 'Grep':
      // `path` outranks `pattern` in the generic summary, which is backwards here.
      return pattern
        ? { summary: pattern, full: path ? `${pattern} in ${path}` : pattern }
        : { summary: generic, full: generic };
    case 'Glob':
      // "Listed docs": the directory it listed, or the pattern when it had none.
      if (path) return { summary: basename(path), full: pattern ? `${pattern} in ${path}` : path };
      return { summary: pattern ?? generic, full: pattern ?? generic };
    case 'WebSearch':
      return { summary: query ?? generic, full: query ?? generic };
    default:
      return { summary: generic, full: generic };
  }
}

/** How long a call stays the folded line before the next may replace it. */
const DWELL_MS = 1200;

/**
 * The call to show while a run is busy, changed no faster than DWELL_MS.
 *
 * Reads and greps report back in a few milliseconds, so the live value can
 * flash through five names in a second, and a line that changes faster than it
 * can be read looks broken rather than busy. Each shown call keeps the line
 * for a beat; when it is up, the line jumps to whatever is running THEN,
 * skipping the ones that came and went — and to the "N tools called" summary
 * (null) if nothing is. A run already finished when it mounts shows its
 * summary at once.
 */
function useSteady(current: ToolPart | null, count: number): ToolPart | null {
  const [shown, setShown] = useState(current);
  const since = useRef(0);
  const latest = useRef(current);
  latest.current = current;

  const target = current?.tool_use_id ?? null;
  const showing = shown?.tool_use_id ?? null;
  useEffect(() => {
    if (target === showing) return;
    const wait = shown === null ? 0 : Math.max(0, since.current + DWELL_MS - Date.now());
    const timer = setTimeout(() => {
      since.current = Date.now();
      setShown(latest.current);
    }, wait);
    return () => { clearTimeout(timer); };
    // `count`: a new call arriving re-arms the check even when the target id
    // was already pending.
  }, [target, showing, shown, count]);

  return shown;
}

/** Icon, verb and what it touched — shared by a call's own row and the folded line. */
function ToolLine({ part, running }: { part: ToolPart; running: boolean }) {
  const { verb, icon: ToolIcon } = describe(part.name);
  const { summary, full } = markerSummary(part);
  const failed = !running && !part.ok;
  return (
    <>
      <MarkerIcon className="flex items-center justify-center">
        {running
          ? <Spinner className="size-3.5" aria-label="running" />
          : failed
            ? <AlertTriangle className="size-3.5 text-destructive" aria-label="failed" />
            : <ToolIcon className="size-3.5" />}
      </MarkerIcon>
      <MarkerContent className={cn('flex min-w-0 items-baseline gap-1.5', running && '*:shimmer')}>
        <span className={cn('shrink-0', failed && 'text-destructive')}>{verb}</span>
        {summary && <span className="min-w-0 truncate font-mono text-xs opacity-80" title={full}>{summary}</span>}
      </MarkerContent>
    </>
  );
}

function ToolCall({ part, running }: { part: ToolPart; running: boolean }) {
  const failed = !running && !part.ok;

  return (
    <AccordionItem value={part.tool_use_id} className="not-last:border-b-0">
      <AccordionPrimitive.Header>
        <Marker
          render={<AccordionPrimitive.Trigger />}
          className="group/tool cursor-pointer rounded-md py-0.5 transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ToolLine part={part} running={running} />
          {!running && (
            <span className="shrink-0 text-xs tabular-nums opacity-70">
              {duration(part.ms)}
            </span>
          )}
          <ChevronRight className="-ml-0.5 size-3.5 shrink-0 opacity-0 transition group-hover/tool:opacity-70 group-aria-expanded/tool:rotate-90 group-aria-expanded/tool:opacity-70" />
        </Marker>
      </AccordionPrimitive.Header>

      <AccordionContent className="pb-1">
        {/* Only what came back: the line above already says what was asked.
            Hung off the icon column, so it reads as belonging to the line. */}
        <div className="mt-1 ml-2 border-l border-border pl-4">
          {part.output_preview ? (
            <pre
              className={cn(
                'max-h-60 overflow-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap select-text',
                failed && 'text-destructive',
              )}
            >
              {part.output_preview}
              {part.output_bytes !== undefined && part.output_bytes > part.output_preview.length
                ? `\n… ${part.output_bytes.toLocaleString()} bytes in all`
                : ''}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">{running ? 'Still running…' : 'No output.'}</p>
          )}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}
