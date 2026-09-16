// A route that reads like a document: padded, and the thing that scrolls.
//
// The shell deliberately does NOT pad its inset. Chat fills the pane edge to
// edge and owns its own scrolling — the message scroller has to be the scroll
// container or its anchoring and position restore have nothing to work with —
// and a shell that padded everything forced Chat to cancel it with a negative
// margin, which is a layout arguing with itself.
//
// So padding is opted INTO, in the route table, where "which surfaces are
// documents" is a statement you can read in one place.
//
// `min-h-0` is not decoration: a flex child defaults to `min-height: auto`,
// which lets its content grow past the container instead of scrolling inside
// it — the composer disappearing off the bottom of the window.
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Page({ className, children }: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('min-h-0 flex-1 overflow-y-auto p-10', className)}>
      {children}
    </div>
  );
}
