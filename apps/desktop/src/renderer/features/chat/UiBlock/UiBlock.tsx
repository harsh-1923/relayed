// One `ui` part of an agent's reply, drawn (docs/AGENT-RESPONSES.md, rendering it).
//
// Three ways a block can fail to draw, and none may take the message with it:
//   - it was written against a NEWER library than this build has — shown as its
//     plain text, with a note, rather than half-drawn;
//   - a component inside it is unknown or broken — OpenUI drops that component
//     and keeps its siblings (measured in spikes/genui, the render spike);
//   - something throws past OpenUI's own boundary — ours shows the plain text.
import { Component, useMemo, type ReactNode } from 'react';
import { Renderer, type ActionEvent } from '@openuidev/react-lang';
import type { UiPart } from '@relayed/protocol';
import { libraryVersion, LIBRARY_VERSION, validateUi } from '@relayed/genui';
import { uiLibrary } from './UiBlock.library';
import '../markdown.css';

export interface UiBlockHandlers {
  /** A Reply was clicked: send `message` as the person who clicked it. */
  onReply?: (reply: { message: string; label: string }) => void;
  /** A Link was clicked. Never navigated to by the renderer itself. */
  onOpenLink?: (url: string) => void;
  /** Parser and render error codes, for the dev surface and, later, telemetry. */
  onErrors?: (codes: string[]) => void;
}

export function UiBlock({
  part, streaming = false, library = uiLibrary, onReply, onOpenLink, onErrors,
}: { part: UiPart; streaming?: boolean; library?: typeof uiLibrary } & UiBlockHandlers) {
  // Plain text for every fallback below. Parsing is sub-millisecond; memoised
  // because a streaming block re-renders on every chunk.
  const fallbackText = useMemo(() => validateUi(part.source).text, [part.source]);

  if (!(libraryVersion(part.library) <= libraryVersion(LIBRARY_VERSION))) {
    return (
      <Fallback text={fallbackText}>
        Part of this reply needs a newer version of Relayed to display.
      </Fallback>
    );
  }

  const onAction = (event: ActionEvent) => {
    if (event.type === 'relayed.reply') {
      const label = event.params['label'];
      onReply?.({ message: event.humanFriendlyMessage, label: typeof label === 'string' ? label : '' });
    } else if (event.type === 'relayed.link') {
      const url = event.params['url'];
      if (typeof url === 'string') onOpenLink?.(url);
    }
  };

  return (
    <Boundary fallback={<Fallback text={fallbackText}>This part of the reply could not be displayed.</Fallback>}>
      {/* The reply's type scale (markdown.css), without its paragraph rhythm:
          inside a block, spacing is the layout's gaps. */}
      <div className="markdown ui-block">
        <Renderer
          library={library}
          response={part.source}
          isStreaming={streaming}
          onAction={onAction}
          onError={errors => onErrors?.(errors.map(error => error.code))}
          // OpenUI's global event bus: nothing here listens to it, and the renderer
          // holds no telemetry of its own (OBSERVABILITY.md, one SDK).
          publishObservability={false}
        />
      </div>
    </Boundary>
  );
}

function Fallback({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div className="flex max-w-2xl flex-col gap-1 rounded-lg border border-dashed border-border px-3 py-2">
      <p className="text-sm text-muted-foreground">{children}</p>
      {text ? <p className="markdown whitespace-pre-wrap">{text}</p> : null}
    </div>
  );
}

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
