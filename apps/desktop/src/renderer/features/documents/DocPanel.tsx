// A document, read beside the chat (docs/DOCUMENTS.md §8.2) — a room's running
// summary, today.
//
// TIPTAP, READ-ONLY, rather than the markdown renderer messages use, and the
// reason is what comes next rather than what is needed now: a document becomes
// collaboratively editable (§3.4), and this is the editor that becomes editable.
// Rendering it with something else would mean throwing this away to get there.
//
// Nobody edits a summary here. Not hidden — `editable: false` — and not the
// guard either: the guard is that the server has no write path for a person
// (§6). This is the affordance matching the rule.
import { useEffect, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import type { Document } from '../../../preload/api';
import { isEmptyDocument, webAddress } from '../../../shared/documents.ts';
import { useActor } from '@/lib/actors';
import { ActorAvatar } from '@/components/ActorAvatar';
import { DocumentMention } from '@/features/chat/composer/ComposerMention';
import { call } from '@/lib/ipc';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TimelinePanel } from './TimelinePanel.tsx';
import './document.css';

/**
 * The same base as the composer's, minus what a document body has no use for.
 *
 * `link.openOnClick: false` is the important one, and it is a SAFETY rule
 * rather than a preference. Tiptap's default is `true`, and this window has no
 * `will-navigate` guard — so a plain anchor in a summary could load Linear (or
 * anything a summary happens to name) over the app itself, preload bridge and
 * all. Messages avoid this by rendering links as buttons (`MarkdownText.tsx`);
 * a document keeps real anchors, for selection and copying, and refuses the
 * click instead. `openLink` below decides what a click actually does.
 */
const extensions = [
  StarterKit.configure({ horizontalRule: false, link: { openOnClick: false } }),
  Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
  // People as chips — the summary refers to them by link (`agents/people.ts`).
  DocumentMention,
];

export function DocPanel({ document, spaceId, onOpenPanel }: {
  document: Document | null; spaceId: string; onOpenPanel: (panelId: string) => void;
}) {

  if (!document) {
    // The panel exists and its document does not: only reachable if a client
    // holds a panel row whose document has not arrived yet.
    return <Waiting>Loading the summary…</Waiting>;
  }
  if (document.format !== 'markdown') {
    // A newer server wrote a format this build cannot render. Say so rather
    // than dumping the source, which is what "kept, not dropped" means here.
    return <Waiting>This document needs a newer version of Relayed.</Waiting>;
  }
  return (
    <DocBody key={document.id} document={document} spaceId={spaceId} onOpenPanel={onOpenPanel} />
  );
}

function DocBody({ document, spaceId, onOpenPanel }: {
  document: Document; spaceId: string; onOpenPanel: (panelId: string) => void;
}) {
  const empty = isEmptyDocument(document);
  const editor = useEditor({
    extensions,
    content: document.body,
    contentType: 'markdown',
    editable: false,
    immediatelyRender: true,
    editorProps: { attributes: { class: 'document-content', 'aria-label': document.title ?? 'Document' } },
  });

  // The body is replaced wholesale on every revision — one writer, one current
  // state (§3.4) — so this sets content rather than merging into it. Keyed on
  // `rev`, not on the body: a rewrite that lands on the same text is not a
  // change anybody needs to see.
  useEffect(() => {
    if (editor && !empty) editor.commands.setContent(document.body, { emitUpdate: false, contentType: 'markdown' });
  }, [editor, document.rev, empty]); // eslint-disable-line react-hooks/exhaustive-deps

  const author = useActor(document.updatedByActorId) ?? null;

  // Two answers to two different questions, in one panel because they are two
  // readings of the same room: the summary says what is true NOW and is
  // rewritten; the timeline says how the room GOT here and never changes
  // (MEMORY.md §14.1). Which one is showing is this device's choice, not
  // anything the room shares.
  const [view, setView] = useState<'summary' | 'timeline'>('summary');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border/60 px-12 py-3">
        <div className="mx-auto flex w-full max-w-[80ch] flex-wrap items-baseline gap-x-2">
          <h2 className="text-sm font-medium">{document.title ?? 'Document'}</h2>
          {/* Honest about its own staleness: who wrote this, and when. */}
          <p className="text-xs text-muted-foreground">
            {empty ? 'Not written yet' : `Updated ${when(document.updatedAt)}`}
            {author && !empty && (
              <> by{' '}
                <span className="inline-flex items-center gap-1 align-bottom">
                  <ActorAvatar id={author.id} className="size-4" fallbackClassName="text-[8px]" profileOnHover />
                  {author.displayName}
                </span>
              </>
            )}
          </p>
          <div className="ml-auto flex items-center gap-1">
            <ViewTab active={view === 'summary'} onClick={() => setView('summary')}>Summary</ViewTab>
            <ViewTab active={view === 'timeline'} onClick={() => setView('timeline')}>Timeline</ViewTab>
            {view === 'summary' && <Refresh spaceId={spaceId} />}
          </div>
        </div>
      </header>

      {view === 'timeline'
        ? <TimelinePanel spaceId={spaceId} />
        : empty
        ? (
          <Waiting>
            Nothing yet — a room’s summary fills in as people talk in it.
          </Waiting>
        )
        : (
          <div className="min-h-0 flex-1 overflow-y-auto px-12 py-10">
            {/* The canvas disables selection globally; Tiptap owns the rendered
                descendants, so restore it through the whole read-only body. */}
            <EditorContent
              editor={editor}
              className={cn('document', 'select-text', '**:select-text')}
              onClick={event => openLink(event, spaceId, onOpenPanel)}
            />
          </div>
        )}
    </div>
  );
}

/** One of the panel's two readings. A button, not a link: nothing about it is addressable. */
function ViewTab({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-pressed={active}
      onClick={onClick}
      className={cn('text-xs', active ? 'text-foreground' : 'text-muted-foreground')}
    >
      {children}
    </Button>
  );
}

/**
 * What clicking a link in a document does.
 *
 * A web page opens as a panel beside the chat — the surface this room already
 * has for a page the work is about (PANELS.md) — and on THIS DEVICE only, the
 * same as opening one by hand. A summary naming a dashboard should not push
 * that dashboard onto everyone else's screen; `local.panels.share` is how a
 * page becomes the room's, and that stays a person's decision.
 *
 * BOTH HALVES, and the second is the one that is easy to forget: opening a
 * panel makes its row, and `onOpenPanel` is what puts it in the tab strip and
 * shows it. Without it a click writes a row nobody can see, which looks exactly
 * like nothing happening.
 *
 * Every other href does nothing at all, which is the whole point: the default
 * would be navigating this window away from Relayed.
 */
function openLink(
  event: React.MouseEvent<HTMLDivElement>, spaceId: string, onOpenPanel: (panelId: string) => void,
): void {
  const anchor = (event.target as HTMLElement).closest('a');
  if (!anchor) return;
  // Refused before anything is decided: a click must never reach the browser's
  // own handling, whatever the href turns out to be.
  event.preventDefault();
  const url = webAddress(anchor.getAttribute('href'));
  if (!url) return;
  void call(api => api.query('local.panels.open', { spaceId, type: 'web', payload: { url } }))
    .then(opened => { if (opened?.id) onOpenPanel(opened.id); });
}

/**
 * Refresh now (DOCUMENTS.md §4.4): the summary otherwise waits for the message
 * count to cross the threshold, and somebody who can see it is behind should
 * not have to talk in the room to make it catch up.
 *
 * Nothing is rendered on success — the revision arrives as an event and the
 * panel redraws from the replica, which is the same path every other update
 * takes. Only a refusal needs saying, because nothing else would say it.
 */
function Refresh({ spaceId }: { spaceId: string }) {
  const [state, setState] = useState<'idle' | 'working' | 'too_soon' | 'failed'>('idle');
  return (
    <span className="ml-auto flex items-center gap-2">
      {state === 'too_soon' && <span className="text-xs text-muted-foreground">Just refreshed</span>}
      {state === 'failed' && <span className="text-xs text-muted-foreground">Could not refresh</span>}
      <Button
        variant="ghost"
        size="xs"
        disabled={state === 'working'}
        onClick={() => {
          setState('working');
          void call(api => api.query('documents.refreshSummary', { spaceId }))
            // Null is the bridge having nothing to say — treated as a failure,
            // since a refresh that did not happen must not look like one that did.
            .then(answer => setState(
              !answer ? 'failed' : answer.ok ? 'idle' : answer.error === 'too_soon' ? 'too_soon' : 'failed'))
            // An offline client throws rather than refusing: the same message,
            // since "could not refresh" is all either of them means here.
            .catch(() => setState('failed'));
        }}
      >
        {state === 'working' ? 'Refreshing…' : 'Refresh'}
      </Button>
    </span>
  );
}

function Waiting({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
      <p className="max-w-xs text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/** Coarse on purpose: a summary is not a clock, and "4 minutes ago" is what somebody wants to know. */
function when(updatedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return new Date(updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
