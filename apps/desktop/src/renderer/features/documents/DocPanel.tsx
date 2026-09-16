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
import { useEffect, useMemo } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import type { Document, ReplicaActor } from '../../../preload/api';
import { isEmptyDocument } from '../../../shared/documents.ts';
import { useQuery } from '@/lib/query';
import { cn } from '@/lib/utils';
import './document.css';

/** The same base as the composer's, minus what a document body has no use for. */
const extensions = [
  StarterKit.configure({ horizontalRule: false }),
  Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
];

export function DocPanel({ document, spaceId }: { document: Document | null; spaceId: string }) {
  const { rows: actors } = useQuery('actors.list');

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
  return <DocBody key={document.id} document={document} actors={actors ?? []} spaceId={spaceId} />;
}

function DocBody({ document, actors }: { document: Document; actors: readonly ReplicaActor[]; spaceId: string }) {
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

  const author = useMemo(
    () => actors.find(actor => actor.id === document.updatedByActorId) ?? null,
    [actors, document.updatedByActorId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-baseline gap-x-2 border-b border-border/60 px-5 py-3">
        <h2 className="text-sm font-medium">{document.title ?? 'Document'}</h2>
        {/* Honest about its own staleness: who wrote this, and when. How far it
            covers joins this line when a writer starts recording a watermark. */}
        <p className="text-xs text-muted-foreground">
          {empty ? 'Not written yet' : `Updated ${when(document.updatedAt)}`}
          {author && !empty && <> by {author.type === 'agent' ? `@${author.handle}` : author.displayName}</>}
        </p>
      </header>

      {empty
        ? (
          <Waiting>
            Nothing yet — a room’s summary fills in as people talk in it.
          </Waiting>
        )
        : (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <EditorContent editor={editor} className={cn('document', 'select-text')} />
          </div>
        )}
    </div>
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
