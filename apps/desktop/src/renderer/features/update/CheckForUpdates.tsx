// "Check for updates", asked by a person (docs/RELEASE.md §1).
//
// ALWAYS ASKS THE SERVER, never reports what `welcome` last said. Somebody
// pressing this is asking what is true now; replaying a cached answer would
// look identical and answer a different question.
//
// EVERY OUTCOME SAYS SOMETHING. A check that quietly changes nothing is
// indistinguishable from one that failed, so "you are up to date" and "could
// not reach the server" are different sentences — and both name the version
// this build actually is, because that is the number somebody is checking.
import { useState } from 'react';
import { call } from '@/lib/ipc';
import { Button } from '@/components/ui/button';

type Result =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; current: string }
  | { kind: 'behind'; current: string; latest: string; minimum: string; url: string }
  | { kind: 'unreachable'; current: string };

export function CheckForUpdates() {
  const [result, setResult] = useState<Result>({ kind: 'idle' });

  const check = async () => {
    setResult({ kind: 'checking' });
    const r = await call(api => api.query('version.check'));
    if (!r) { setResult({ kind: 'idle' }); return; }
    if (!r.ok) { setResult({ kind: 'unreachable', current: r.current }); return; }
    if (r.state.status === 'ok') { setResult({ kind: 'current', current: r.current }); return; }
    setResult({
      kind: 'behind',
      current: r.current,
      latest: r.state.latest,
      url: r.state.url,
      // Only a required update carries a floor; an offer has none to show.
      minimum: r.state.status === 'update_required' ? r.state.minimum : '',
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        size="sm"
        variant="outline"
        disabled={result.kind === 'checking'}
        onClick={() => void check()}
      >
        {result.kind === 'checking' ? 'Checking…' : 'Check for updates'}
      </Button>

      {result.kind === 'current' && (
        <span className="text-xs text-muted-foreground">
          You&rsquo;re on {result.current}, the latest version.
        </span>
      )}

      {result.kind === 'unreachable' && (
        <span className="text-xs text-muted-foreground">
          Could not reach the server. You&rsquo;re on {result.current}.
        </span>
      )}

      {result.kind === 'behind' && (
        <span className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
          <span>
            Version {result.latest} is available. You&rsquo;re on {result.current}.
            {result.minimum && ` ${result.minimum} or newer is required.`}
          </span>
          <Button
            size="sm"
            onClick={() => result.url && window.open(result.url, '_blank', 'noopener')}
          >
            Download {result.latest}
          </Button>
        </span>
      )}
    </div>
  );
}
