import './index.css';
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppState, RelayedApi, WorkspaceRow } from '../preload/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

declare const window: Window & { relayed?: RelayedApi };

/**
 * A reply superseded by a workspace switch is not a failure — it belongs to the
 * workspace we just left (STORAGE.md §12.1). Normalised to null here so no call
 * site has to remember.
 *
 * The marker rides on the value rather than on an Error, because contextBridge
 * strips custom properties off Errors.
 */
async function call<T>(fn: () => Promise<T>): Promise<T | null> {
  const v = await fn();
  const key = window.relayed?.STALE;
  if (key && v && typeof v === 'object' && key in v) return null;
  return v;
}

const initials = (s: string) =>
  s.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

/** §9 decision 1: an org is created here, on demand — never at signup. */
function WorkspaceForm(props: {
  defaultName: string;
  suggestions: string[];
  submitLabel: string;
  onError: (m: string | null) => void;
  onDone?: () => void;
}) {
  const [name, setName] = useState(props.defaultName);
  // Pre-filled and editable — never auto-suffixed (§10).
  const [handle, setHandle] = useState(props.suggestions[0] ?? '');
  const [busy, setBusy] = useState(false);

  const create = useCallback(async () => {
    setBusy(true); props.onError(null);
    try {
      await call(() => window.relayed!.query('auth.createWorkspace', { workspaceName: name, handle }));
      props.onDone?.();
    } catch (e) { props.onError((e as Error).message); }
    finally { setBusy(false); }
  }, [name, handle, props]);

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
          <Input id="handle" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} />
        </div>
        {/* Handles are per workspace: taken here does not mean taken there (§10). */}
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
        {busy ? 'Creating…' : props.submitLabel}
      </Button>
    </div>
  );
}

/**
 * The workspace rail.
 *
 * Drawn entirely from account.db, so it is correct on a cold boot with no
 * network and before any authentication (STORAGE.md §6, §11).
 */
function Switcher(props: { state: AppState; onCreate: () => void; creating: boolean }) {
  const { workspaces, workspaceId } = props.state;

  // Above the early return: a hook must not be reached conditionally.
  const pick = useCallback(async (id: string) => {
    if (id === workspaceId) return;
    // Returns as soon as the replica is open — the repaint does NOT wait on a
    // token or a socket, which is what lets a switch work offline (§12.2).
    await call(() => window.relayed!.query('workspace.switch', { workspaceId: id }));
  }, [workspaceId]);

  if (workspaces.length === 0 && !props.creating) return null;

  return (
    <nav className="flex w-16 shrink-0 flex-col items-center gap-2 border-r bg-sidebar py-3"
         aria-label="Workspaces">
      {workspaces.map((w: WorkspaceRow) => {
        const active = w.workspaceId === workspaceId;
        return (
          <button key={w.workspaceId} onClick={() => void pick(w.workspaceId)}
                  title={`${w.name} · @${w.handle}`} aria-current={active}
                  className={`relative grid size-10 place-items-center rounded-xl text-sm font-medium
                    transition-colors ${active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'}`}>
            {initials(w.name)}
            {w.mentionHint > 0 && (
              <span className="absolute -right-0.5 -top-0.5 grid size-4 place-items-center
                               rounded-full bg-destructive text-[10px] text-white">
                {w.mentionHint > 9 ? '9+' : w.mentionHint}
              </span>
            )}
            {/* Writes parked here while another workspace is active (§15.2). */}
            {w.outboxHint > 0 && (
              <span title={`${w.outboxHint} unsent`}
                    className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-amber-500" />
            )}
          </button>
        );
      })}
      <button onClick={props.onCreate} title="New workspace"
              className="grid size-10 place-items-center rounded-xl border border-dashed
                         text-muted-foreground hover:bg-accent hover:text-accent-foreground">
        +
      </button>
    </nav>
  );
}

function Identity(props: {
  state: AppState;
  onError: (m: string | null) => void;
  onState: (s: AppState | null) => void;
}) {
  const auth = props.state.auth;
  const [busy, setBusy] = useState(false);

  const signIn = useCallback(async () => {
    setBusy(true); props.onError(null);
    try { props.onState(await call(() => window.relayed!.query('auth.signIn'))); }
    catch (e) { props.onError((e as Error).message); }
    finally { setBusy(false); }
  }, [props]);

  // The reply is the authoritative post-sign-out state. The push that fires
  // partway through describes a half-finished sign-out, so discarding this and
  // relying on the push alone leaves the UI showing a workspace that is gone.
  const signOut = useCallback(async () => {
    props.onState(await call(() => window.relayed!.query('auth.signOut')));
  }, [props]);

  const active = props.state.workspaces.find(w => w.workspaceId === props.state.workspaceId);

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {active?.name ?? 'Identity'}
          <Badge variant={auth.status === 'authenticated' ? 'default' : 'secondary'}>
            {auth.status.replace('_', ' ')}
          </Badge>
        </CardTitle>
        <CardDescription>
          WorkOS AuthKit → our session · system browser · PKCE · loopback
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {auth.status === 'stale' && (
          <Alert>
            <AlertTitle>Reconnect to sync</AlertTitle>
            <AlertDescription>
              Could not refresh the session ({auth.reason}). Local data is unaffected.
            </AlertDescription>
          </Alert>
        )}

        {auth.status === 'needs_workspace' ? (
          <>
            <p className="text-sm text-muted-foreground">
              Signed in as {auth.identity.email}. Name your workspace to finish.
            </p>
            <WorkspaceForm
              defaultName={auth.identity.displayName
                ? `${auth.identity.displayName}'s workspace` : 'My workspace'}
              suggestions={auth.handleSuggestions}
              submitLabel="Create workspace"
              onError={props.onError} />
          </>
        ) : auth.status === 'authenticated' || active ? (
          <div className="flex items-center gap-3">
            <Avatar>
              {/* No <AvatarImage> deliberately. `avatarUrl` is a remote
                  workoscdn.com URL, and rendering it would (a) trip the CSP,
                  which is correct to block it, and (b) leave avatars blank
                  offline — the exact failure R3 exists to prevent. Initials
                  until the blob store lands (DESIGN.md §13.3). */}
              <AvatarFallback>{initials(active?.displayName ?? '??')}</AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <div className="font-medium">{active?.displayName ?? 'Signed in'}</div>
              <div className="text-sm text-muted-foreground">
                {/* The handle is per workspace, so it comes from the row, not the actor. */}
                {active?.handle ? `@${active.handle}` : ''}
              </div>
            </div>
            {/* Account-level, not workspace-level: one identity holds every
                workspace here, so the button says how many it affects. */}
            <Button variant="outline" onClick={signOut}>
              {props.state.workspaces.length > 1
                ? `Sign out of all ${props.state.workspaces.length}` : 'Sign out'}
            </Button>
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

/**
 * A one-line statement of what the client is actually reading from.
 *
 * The full on-disk inspector this replaces did its job — it proved that
 * sign-out cleanup was correct and that the UI, not the disk, was lying — and
 * it is `debug.snapshot` away if it is needed again (Storage.debug()).
 */
function Replica(props: { state: AppState }) {
  const active = props.state.workspaces.find(w => w.workspaceId === props.state.workspaceId);
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="text-base">Local replica</CardTitle>
        <CardDescription>renderer → MessagePort → utilityProcess → SQLite</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1 font-mono text-xs text-muted-foreground">
        <div>account   {props.state.accountId ?? '—'}</div>
        <div>workspace {active ? `${active.name} · @${active.handle}` : '—'}</div>
        <div>replicas  {props.state.workspaces.length} known · epoch {props.state.epoch}</div>
      </CardContent>
    </Card>
  );
}

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!window.relayed) return;
    void window.relayed.query('app.state').then(setState);
    // Sign-in completes in the browser, and a switch resolves its token after
    // the repaint — so state arrives as a push, not as a return value.
    return window.relayed.subscribe('app:state', (s) => { setState(s); setCreating(false); });
  }, []);

  if (!window.relayed) {
    return <main className="p-10 text-sm text-muted-foreground">
      Standalone renderer — the sync engine is not attached.
    </main>;
  }
  if (!state) return <main className="min-h-svh bg-background" />;

  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <Switcher state={state} creating={creating} onCreate={() => setCreating(true)} />
      {/* Keyed on the epoch: a switch drops the whole subtree rather than
          merging, which is the coarsest form of §11.2's coarse invalidation. */}
      <main key={state.epoch} className="flex-1 space-y-6 p-10">
        <div>
          <h1 className="text-lg font-semibold">Relayed</h1>
          <p className="text-sm text-muted-foreground">Phase 1 — Identity</p>
        </div>

        {error && (
          <Alert variant="destructive" className="max-w-xl">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {creating ? (
          <Card className="max-w-xl">
            <CardHeader>
              <CardTitle>New workspace</CardTitle>
              <CardDescription>
                A separate org, actor and local replica. Your handle here can differ.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <WorkspaceForm defaultName="" suggestions={[]} submitLabel="Create workspace"
                             onError={setError} onDone={() => setCreating(false)} />
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>Cancel</Button>
            </CardContent>
          </Card>
        ) : (
          <Identity state={state} onError={setError}
                    onState={(s) => { if (s) setState(s); }} />
        )}

        <Separator />
        <Replica state={state} />
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
