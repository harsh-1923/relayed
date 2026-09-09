// PHASE-1-IDENTITY §9 decision 1: an org is created here, on demand — never at
// signup.
import { useCallback, useState } from 'react';
import type { AppState } from '../../../preload/api';
import { call } from '@/lib/ipc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function WorkspaceForm(props: {
  defaultName: string;
  suggestions: string[];
  submitLabel: string;
  onError: (m: string | null) => void;
  onDone: (s: AppState) => void;
}) {
  const [name, setName] = useState(props.defaultName);
  // Pre-filled and editable — never auto-suffixed (PHASE-1-IDENTITY §10).
  const [handle, setHandle] = useState(props.suggestions[0] ?? '');
  const [busy, setBusy] = useState(false);
  const { onError, onDone } = props;

  const create = useCallback(async () => {
    setBusy(true); onError(null);
    try {
      const s = await call(api =>
        api.query('auth.createWorkspace', { workspaceName: name, handle }));
      if (s) onDone(s);
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  }, [name, handle, onError, onDone]);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="ws">Workspace name</Label>
        <Input id="ws" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="handle">Your handle</Label>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">@</span>
          <Input id="handle" value={handle}
                 onChange={(e) => setHandle(e.target.value.toLowerCase())} />
        </div>
        {/* Handles are per workspace: taken here does not mean taken there. */}
        {props.suggestions.length > 1 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {props.suggestions.map((s) => (
              <Button key={s} size="sm" variant={s === handle ? 'secondary' : 'ghost'}
                      onClick={() => setHandle(s)}>@{s}</Button>
            ))}
          </div>
        )}
      </div>
      <Button onClick={() => void create()}
              disabled={busy || !name.trim() || handle.length < 3}>
        {busy ? 'Creating…' : props.submitLabel}
      </Button>
    </div>
  );
}
