// An answer nobody asked for (docs/AMBIENT-RESPONSES.md, the client §11).
//
// Said in the header, with the question it answers, because an unrequested
// message that looks exactly like a requested one cannot be told apart or
// turned off. And a way to say "not helpful" in the footer, kept as feedback
// on the answer (§10.2).
import { useState } from 'react';
import type { AmbientPart } from '@relayed/protocol';
import { useMessageScroller } from '@/components/ui/message-scroller';
import { call } from '@/lib/ipc';
import { cn } from '@/lib/utils';

/**
 * "· unprompted · ↪ Alice". The reference is the server's, never the model's
 * (`AmbientPart`), and it jumps to the question: people may have posted while
 * the agent worked, so the answer is not always directly under it.
 */
export function AmbientReference({ part }: { part: AmbientPart }) {
  const { scrollToMessage } = useMessageScroller();
  return (
    <span className="text-muted-foreground">
      {' · unprompted · '}
      <button
        type="button"
        title="Go to the message this answers"
        className="hover:text-foreground hover:underline"
        // False when the question is older than what is loaded — the scroller
        // says so rather than scrolling somewhere wrong, and nothing happens.
        onClick={() => { scrollToMessage(part.answering); }}
      >
        ↪ {part.asker}
      </button>
    </span>
  );
}

/**
 * "Not helpful here". Anyone in the chat may press it, once each. It is kept as
 * feedback on the answer and changes nothing about when the agent speaks.
 * Online-only, like stopping a run.
 */
export function DismissAmbient({ messageId, className }: { messageId: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'failed'>('idle');
  if (state === 'done') return <span className="text-muted-foreground">Marked not helpful</span>;
  return (
    <button
      type="button"
      disabled={state === 'working'}
      title="Mark this unprompted answer as not helpful"
      className={cn('rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60',
        state === 'failed' && 'text-destructive', className)}
      onClick={() => {
        setState('working');
        void call(api => api.query('ambient.dismiss', { messageId }))
          .then(answer => { setState(answer?.ok ? 'done' : 'failed'); })
          .catch(() => { setState('failed'); });
      }}
    >
      {state === 'failed' ? 'Could not send — try again' : 'Not helpful here'}
    </button>
  );
}
