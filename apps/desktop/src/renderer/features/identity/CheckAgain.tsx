// Ask the server again what this person can join (ORG-DOMAINS.md). What they
// were offered was computed at sign-in; a company whose domain is set up while
// they are on this screen only shows once they ask. On request only, so the
// screen never changes under someone mid-read.
import { useState } from 'react';
import { useSession } from '@/app/state';
import { call } from '@/lib/ipc';

export function CheckAgain({ prompt }: { prompt: string }) {
  const { state, apply } = useSession();
  const [checking, setChecking] = useState(false);
  if (state.auth.status !== 'needs_workspace') return null;

  const recheck = async () => {
    setChecking(true);
    try { apply(await call(api => api.query('auth.recheckOnboarding'))); }
    catch { /* keep what we had */ }
    finally { setChecking(false); }
  };

  return (
    <p className="text-xs text-muted-foreground">
      {prompt}{' '}
      <button type="button" disabled={checking} onClick={() => void recheck()}
              className="rounded-sm font-medium text-foreground/80 underline-offset-4 hover:text-foreground
                         hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60">
        {checking ? 'Checking…' : 'Check again'}
      </button>
    </p>
  );
}
