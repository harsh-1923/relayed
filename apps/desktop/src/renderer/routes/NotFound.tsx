// A URL that matches nothing.
//
// Reachable in normal use, not just by mistyping: a link shared from a newer
// build can name a route this one does not have. So it says what happened and
// offers a way back, rather than rendering a blank window.
import { Link, useLocation } from 'react-router';
import { buttonVariants } from '@/components/ui/button';

export function NotFound() {
  const { pathname } = useLocation();
  return (
    <main className="grid min-h-svh place-items-center bg-background p-10 text-foreground">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-lg font-semibold">Nothing here</h1>
        <p className="text-sm text-muted-foreground">
          This link does not match anything in this build. It may come from a
          newer version.
        </p>
        <p className="font-mono text-xs text-muted-foreground">{pathname}</p>
        <Link to="/" className={buttonVariants({ variant: 'outline' })}>Go back</Link>
      </div>
    </main>
  );
}
