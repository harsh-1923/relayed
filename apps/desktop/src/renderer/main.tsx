import './index.css';
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppState, Invitation, PendingJoin, RelayedApi, WorkspaceRow } from '../preload/api';
import { can, workspace as wsTarget, type Grants, type Role } from '@relayed/authz';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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

/**
 * Local bytes only — never the remote URL the server gave us. Served by main
 * over a custom scheme so `webSecurity` stays on and no filesystem path reaches
 * the DOM (DESIGN.md §13.3). Absent until the prefetch lands, which is what the
 * initials fallback is for.
 */
const blobSrc = (id: string | null) => (id ? `relayed-blob://${id}` : undefined);

/**
 * The client's mirror of the server's evaluator — the SAME function, from
 * @relayed/authz, not a second implementation that could drift (AUTHZ.md §12.2).
 *
 * It answers from replicated state and never touches the network, which is what
 * lets the UI be correct offline (§3). It may only HIDE a control it believes is
 * denied; the server re-checks every write regardless (invariant 49), so being
 * wrong here is an affordance that fails on use, not a permission granted.
 */
const grantsOf = (state: AppState): Grants =>
  new Map(state.grants as [string, Role][]);

const initials = (s: string) =>
  s.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

/**
 * A stable colour per workspace, derived from its id.
 *
 * The rail exists to tell workspaces apart at a glance, and initials alone stop
 * doing that the moment two of them start with the same letter. Derived rather
 * than stored so it needs no schema and never disagrees between devices.
 */
function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

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
        // The WORKSPACE's identity, never the member's — the field names now
        // make that hard to get wrong. A workspace image is optional and
        // usually absent; initials on a derived colour are the fallback, and a
        // perfectly good one.
        return (
          <button key={w.workspaceId} onClick={() => void pick(w.workspaceId)}
                  title={`${w.name} · @${w.actorHandle}`} aria-current={active}
                  style={{ backgroundColor: active || w.workspaceAvatarBlob ? undefined
                    : `oklch(0.34 0.07 ${hueFor(w.workspaceId)})` }}
                  className={`relative grid size-10 place-items-center overflow-hidden rounded-xl
                    text-sm font-medium transition-[opacity,box-shadow] ${active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-foreground/85 opacity-80 hover:opacity-100'}`}>
            {w.workspaceAvatarBlob
              ? <img src={blobSrc(w.workspaceAvatarBlob)} alt=""
                     className="size-full object-cover" />
              : initials(w.name)}
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
  
  // Deliberately NOT awaited into a local `busy` flag. auth.signIn does not
  // resolve until the browser comes back — up to five minutes — and a local
  // flag is lost the moment the window reloads, which left the previous
  // version showing a dead "Waiting for the browser…" with no way out.
  // `awaitingBrowser` is pushed from the process that actually knows.
  const signIn = useCallback(() => {
    props.onError(null);
    void call(() => window.relayed!.query('auth.signIn'))
      .then((s) => props.onState(s))
      .catch((e: Error) => props.onError(e.message));
  }, [props]);

  const cancelSignIn = useCallback(async () => {
    props.onError(null);
    props.onState(await call(() => window.relayed!.query('auth.cancelSignIn')));
  }, [props]);

  const reopen = useCallback(async () => {
    props.onError(null);
    await call(() => window.relayed!.query('auth.reopenBrowser'));
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
              Signed in as {auth.identity.email}.
              {auth.pendingJoins.length > 0
                ? ' Join a workspace you were invited to, or create your own.'
                : ' Name your workspace to finish.'}
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
              <AvatarImage src={blobSrc(active?.actorAvatarBlob ?? null)} />
              <AvatarFallback>{initials(active?.actorDisplayName ?? '??')}</AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <div className="font-medium">{active?.actorDisplayName ?? 'Signed in'}</div>
              <div className="text-sm text-muted-foreground">
                {/* The handle is per workspace, so it comes from the row, not the actor. */}
                {active?.actorHandle ? `@${active.actorHandle}` : ''}
              </div>
            </div>
            {/* Account-level, not workspace-level: one identity holds every
                workspace here, so the button says how many it affects. */}
            <Button variant="outline" onClick={signOut}>
              {props.state.workspaces.length > 1
                ? `Sign out of all ${props.state.workspaces.length}` : 'Sign out'}
            </Button>
          </div>
        ) : props.state.awaitingBrowser ? (
          // Three ways out, because there are three things that go wrong: the
          // browser opened and was dismissed, the browser never appeared, or
          // the person changed their mind. Previously all three led to a
          // disabled button and a five-minute wait.
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Waiting for your browser. Finish signing in there, and this window
              will catch up on its own.
            </p>
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => void reopen()}>
                Open the link again
              </Button>
              <Button variant="ghost" onClick={() => void cancelSignIn()}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button onClick={signIn}>Sign in</Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Invitations. Rendered only where the local mirror says the action exists. */
function Invitations(props: { state: AppState; onError: (m: string | null) => void }) {
  const [list, setList] = useState<Invitation[] | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const wsId = props.state.workspaceId;

  const mayInvite = wsId ? can(grantsOf(props.state), 'invite', wsTarget(wsId)) : false;
  const mayManage = wsId ? can(grantsOf(props.state), 'manage_members', wsTarget(wsId)) : false;

  const refresh = useCallback(async () => {
    if (!mayManage) return;
    const v = await call(() => window.relayed!.query('invite.list'));
    if (v) setList(v.invitations);
  }, [mayManage]);

  useEffect(() => { void refresh(); }, [refresh, wsId]);

  const send = useCallback(async () => {
    setBusy(true); props.onError(null);
    try {
      await call(() => window.relayed!.query('invite.create', { email: email.trim() }));
      setEmail('');
      await refresh();
    } catch (e) { props.onError((e as Error).message); }
    finally { setBusy(false); }
  }, [email, props, refresh]);

  const revoke = useCallback(async (id: string) => {
    try { await call(() => window.relayed!.query('invite.revoke', { id })); await refresh(); }
    catch (e) { props.onError((e as Error).message); }
  }, [props, refresh]);

  // Hidden, not disabled: an affordance that exists but always fails teaches
  // people the app is broken rather than that they lack a permission.
  if (!mayInvite && !mayManage) return null;

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="text-base">Invite people</CardTitle>
        <CardDescription>
          They receive an email, sign in, and choose a handle for this workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {mayInvite && (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input id="invite-email" type="email" placeholder="person@example.com"
                     value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <Button onClick={send} disabled={busy || !email.includes('@')}>
              {busy ? 'Sending…' : 'Invite'}
            </Button>
          </div>
        )}

        {mayManage && list && list.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Pending ({list.length})
            </div>
            {list.map(i => (
              <div key={i.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-mono text-xs">{i.email}</span>
                <Button size="sm" variant="ghost" onClick={() => void revoke(i.id)}>Revoke</Button>
              </div>
            ))}
          </div>
        )}
        {mayManage && list && list.length === 0 && (
          <p className="text-sm text-muted-foreground">No invitations pending.</p>
        )}
      </CardContent>
    </Card>
  );
}

/** A workspace we have been admitted to and have no actor in yet (§9). */
function PendingJoins(props: {
  joins: PendingJoin[]; onError: (m: string | null) => void; onState: (s: AppState | null) => void;
}) {
  const [pick, setPick] = useState<PendingJoin | null>(props.joins[0] ?? null);
  const [handle, setHandle] = useState(props.joins[0]?.handleSuggestions[0] ?? '');
  const [busy, setBusy] = useState(false);
  if (props.joins.length === 0) return null;

  const join = async () => {
    if (!pick) return;
    setBusy(true); props.onError(null);
    try {
      props.onState(await call(() => window.relayed!.query(
        'auth.join', { workspaceId: pick.workspaceId, handle })));
    } catch (e) { props.onError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="text-base">You have been invited</CardTitle>
        <CardDescription>
          Choose a handle for this workspace. Handles are per workspace, so one you
          use elsewhere may already be taken here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.joins.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {props.joins.map(j => (
              <Button key={j.workspaceId} size="sm"
                      variant={j.workspaceId === pick?.workspaceId ? 'secondary' : 'ghost'}
                      onClick={() => { setPick(j); setHandle(j.handleSuggestions[0] ?? ''); }}>
                {j.name}
              </Button>
            ))}
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="join-handle">Your handle in {pick?.name}</Label>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">@</span>
            <Input id="join-handle" value={handle}
                   onChange={(e) => setHandle(e.target.value.toLowerCase())} />
          </div>
          {(pick?.handleSuggestions.length ?? 0) > 1 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {pick?.handleSuggestions.map(sug => (
                <Button key={sug} size="sm" variant={sug === handle ? 'secondary' : 'ghost'}
                        onClick={() => setHandle(sug)}>@{sug}</Button>
              ))}
            </div>
          )}
        </div>
        <Button onClick={() => void join()} disabled={busy || handle.length < 3}>
          {busy ? 'Joining…' : `Join ${pick?.name ?? ''}`}
        </Button>
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
        <div>workspace {active ? `${active.name} · @${active.actorHandle}` : '—'}</div>
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
          <>
            {/* An invited person has no workspace of their own, and pushing
                them into creating one reads as a broken invite (§9). */}
            {state.auth.status === 'needs_workspace' && (
              <PendingJoins joins={state.auth.pendingJoins} onError={setError}
                            onState={(s) => { if (s) setState(s); }} />
            )}
            <Identity state={state} onError={setError}
                      onState={(s) => { if (s) setState(s); }} />
            <Invitations state={state} onError={setError} />
          </>
        )}

        <Separator />
        <Replica state={state} />
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
