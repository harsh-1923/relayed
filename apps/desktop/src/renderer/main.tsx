import './index.css';
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthState, DbInfo, RelayedApi } from '../preload/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

declare const window: Window & { relayed?: RelayedApi };

/** §9 decision 1: an org is created here, on demand — never at signup. */
function Onboarding(props: {
  identity: { email: string; displayName: string };
  suggestions: string[];
  onError: (m: string | null) => void;
}) {
  const [name, setName] = useState(
    props.identity.displayName ? `${props.identity.displayName}'s workspace` : 'My workspace');
  // Pre-filled and editable — never auto-suffixed (§10).
  const [handle, setHandle] = useState(props.suggestions[0] ?? '');
  const [busy, setBusy] = useState(false);

  const create = useCallback(async () => {
    setBusy(true); props.onError(null);
    try { await window.relayed!.query('auth.createWorkspace', { workspaceName: name, handle }); }
    catch (e) { props.onError((e as Error).message); }
    finally { setBusy(false); }
  }, [name, handle, props]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Signed in as {props.identity.email}. Name your workspace to finish.
      </p>
      <div className="space-y-2">
        <Label htmlFor="ws">Workspace name</Label>
        <Input id="ws" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="handle">Your handle</Label>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">@</span>
          <Input id="handle" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} />
        </div>
        {props.suggestions.length > 1 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {props.suggestions.map((s) => (
              <Button key={s} size="sm" variant={s === handle ? 'secondary' : 'ghost'}
                      onClick={() => setHandle(s)}>@{s}</Button>
            ))}
          </div>
        )}
      </div>
      <Button onClick={create} disabled={busy || !name.trim() || handle.length < 3}>
        {busy ? 'Creating…' : 'Create workspace'}
      </Button>
    </div>
  );
}

function Identity() {
  const [auth, setAuth] = useState<AuthState>({ status: 'signed_out' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!window.relayed) return;
    void window.relayed.query('auth.state').then(setAuth);
    // Sign-in completes in the browser, so the result arrives as a push rather
    // than as the return value of a click.
    return window.relayed.subscribe('auth:state', setAuth);
  }, []);

  const signIn = useCallback(async () => {
    setBusy(true); setError(null);
    try { await window.relayed!.query('auth.signIn'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, []);

  const signOut = useCallback(async () => { await window.relayed!.query('auth.signOut'); }, []);

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Identity
          <Badge variant={auth.status === 'authenticated' ? 'default' : 'secondary'}>
            {auth.status.replace('_', ' ')}
          </Badge>
        </CardTitle>
        <CardDescription>
          WorkOS AuthKit → our session · system browser · PKCE · loopback
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {auth.status === 'stale' && (
          <Alert>
            <AlertTitle>Reconnect to sync</AlertTitle>
            <AlertDescription>
              Could not refresh the session ({auth.reason}). Local data is unaffected.
            </AlertDescription>
          </Alert>
        )}

        {auth.status === 'needs_workspace' ? (
          <Onboarding identity={auth.identity} suggestions={auth.handleSuggestions} onError={setError} />
        ) : auth.status === 'authenticated' ? (
          <div className="flex items-center gap-3">
            <Avatar>
              {auth.actor?.avatarUrl && <AvatarImage src={auth.actor.avatarUrl} />}
              <AvatarFallback>
                {(auth.actor?.displayName ?? '??').slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <div className="font-medium">{auth.actor?.displayName ?? 'Signed in'}</div>
              <div className="text-sm text-muted-foreground">
                {auth.actor?.handle ? `@${auth.actor.handle}` : auth.actor?.id}
              </div>
            </div>
            <Button variant="outline" onClick={signOut}>Sign out</Button>
          </div>
        ) : (
          <Button onClick={signIn} disabled={busy || auth.status === 'authenticating'}>
            {busy || auth.status === 'authenticating' ? 'Waiting for the browser…' : 'Sign in'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function LocalState() {
  const [info, setInfo] = useState<DbInfo | null>(null);
  useEffect(() => { void window.relayed?.query('db.info').then(setInfo); }, []);
  if (!info) return null;
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Local replica</CardTitle>
        <CardDescription>renderer → MessagePort → utilityProcess → SQLite</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableBody>
            {Object.entries(info).map(([k, v]) => (
              <TableRow key={k}>
                <TableCell className="text-muted-foreground w-44">{k}</TableCell>
                <TableCell className="font-mono text-sm">{String(v)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function App() {
  if (!window.relayed) {
    return <main className="p-10 text-sm text-muted-foreground">
      Standalone renderer — the sync engine is not attached.
    </main>;
  }
  return (
    <main className="min-h-svh bg-background text-foreground p-10 space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Relayed</h1>
        <p className="text-sm text-muted-foreground">Phase 1 — Identity</p>
      </div>
      <Identity />
      <Separator />
      <LocalState />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
