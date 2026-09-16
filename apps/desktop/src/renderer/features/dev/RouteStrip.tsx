// The route being rendered, in the top bar — development builds only.
//
// Panels, threads and the open tabs all live in the query (PANELS.md §8), so
// watching this is how to see what the room view believes is open. The query's
// own keys are spaced out: `?p=pnl_A,pnl_B &pa=pnl_B &pn` reads at a glance
// where the raw string does not.
import { useLocation } from 'react-router';
import { useSession } from '@/app/state';

export function RouteStrip() {
  const { state } = useSession();
  const { pathname, search } = useLocation();
  if (!state.devTools) return null;

  const query = [...new URLSearchParams(search).entries()];
  const full = `${pathname}${search}`;

  return (
    <div
      title={full}
      className="w-full no-drag mr-2 flex h-6 min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-2 font-mono text-[11px] text-muted-foreground select-text"
    >
      <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] tracking-wide uppercase">route</span>
      <span className="truncate text-muted-foreground">{pathname}</span>
      {query.map(([key, value]) => (
        <span key={key} className="shrink-0">
          <span className="text-muted-foreground">{key}</span>
          {value !== '' && <span className="text-foreground">={value}</span>}
        </span>
      ))}
    </div>
  );
}
