// Somewhere you may enter and have no actor in yet (PHASE-1-IDENTITY §9,
// ORG-DOMAINS.md). Three ways to have arrived, one screen, one call:
//
//   invited   an invitation accepted at WorkOS — `pendingJoins`
//   company   your verified email is on a domain an org approved — `orgMatches`
//   picked    an open workspace chosen from an org's page — router state
//
// Every one of them is `auth.join` with a workspace id and a handle; the server
// decides which way in applies, so the client never has to.
//
// TWO STEPS: the list of everywhere you could go, then the handle for the one
// you picked. A handle belongs to one workspace, so asking for it before the
// choice is made reads as a form for all of them at once.
//
// Signed in as well as during onboarding. A person who created their own
// workspace first and was invited — or whose company approved its domain —
// afterwards is authenticated, and used to be bounced to "create" from here.
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import type { OrgMatch, PendingJoin } from '../../preload/api';
import { useSession } from '@/app/state';
import { call, hueFor, initials } from '@/lib/ipc';
import { EXPIRED_SIGN_IN, isExpiredSignIn } from '@/lib/onboarding';
import { CheckAgain } from '@/features/identity/CheckAgain';
import { LockClose } from '@relayed/icons';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Candidate {
  workspaceId: string;
  name: string;
  why: string;
  kind: 'invited' | 'company' | 'picked';
  handleSuggestions: string[];
  /** An inline image or a local blob URL; null draws initials. */
  logo: string | null;
  orgName: string;
  /** People in this workspace. */
  memberCount: number;
  inviteOnly: boolean;
}

/** What the org page hands over when someone picks an open workspace. */
export interface PickedWorkspace {
  workspaceId: string; name: string; orgName: string; memberCount: number; handle?: string; logo?: string;
}

const fromInvite = (j: PendingJoin): Candidate => ({
  workspaceId: j.workspaceId, name: j.name,
  // `member`: already in its org — WorkOS can put a person there by itself,
  // from a domain verified in WorkOS — so "invited" would be untrue.
  why: j.reason === 'invited' ? 'You were invited'
    : j.reason === 'company'
      ? (j.isDefault ? 'Your company · where colleagues land' : 'Open to everyone at your company')
      : (j.isDefault ? 'Your organization · where colleagues land' : 'Open to your organization'),
  // In the org by a domain WorkOS verified is the same story as a domain match:
  // your company is here.
  kind: j.reason === 'company' ? 'company' : 'invited', handleSuggestions: j.handleSuggestions, logo: j.logo,
  orgName: j.orgName, memberCount: j.memberCount, inviteOnly: j.inviteOnly,
});
// One row per open WORKSPACE of a matching org (option 2): the default says it
// is where colleagues land, the others say whose they are.
const fromMatch = (m: OrgMatch): Candidate => ({
  workspaceId: m.workspaceId, name: m.workspaceName,
  why: m.isDefault
    ? `${m.name} · ${m.memberCount} ${m.memberCount === 1 ? 'person' : 'people'} · where colleagues land`
    : `Open to everyone in ${m.name}`,
  kind: 'company', handleSuggestions: m.handleSuggestions, logo: m.logo,
  orgName: m.name, memberCount: m.workspaceMemberCount, inviteOnly: false,
});

const REFUSALS: Record<string, string> = {
  not_invited: 'That workspace is no longer open to you. It may have become invite-only, or its domain was removed.',
  handle_taken: 'That handle is taken in this workspace. Pick another — handles are per workspace.',
  workos_unavailable: 'Sign-in service is unreachable. Try again in a moment.',
};

export function JoinWorkspace() {
  const { state, apply } = useSession();
  const navigate = useNavigate();
  const picked = (useLocation().state as { pick?: PickedWorkspace } | null)?.pick;

  // Signed in: the session carries accepted invitations, but not company
  // matches — those need the verified email, read live when asked (§10).
  const [live, setLive] = useState<{ pendingJoins: PendingJoin[]; orgMatches: OrgMatch[] } | null>(null);
  const [loading, setLoading] = useState(state.auth.status !== 'needs_workspace');
  useEffect(() => {
    if (state.auth.status === 'needs_workspace') return;
    let gone = false;
    void call(api => api.query('org.matches'))
      .then(v => { if (!gone && v) setLive(v); })
      .catch(() => {})
      .finally(() => { if (!gone) setLoading(false); });
    return () => { gone = true; };
  }, [state.auth.status]);

  const candidates = useMemo(() => {
    const auth = state.auth;
    const invites = auth.status === 'needs_workspace' || auth.status === 'authenticated' ? auth.pendingJoins : [];
    const matches = auth.status === 'needs_workspace' ? auth.orgMatches : [];
    const all: Candidate[] = [
      ...(picked ? [{
        workspaceId: picked.workspaceId, name: picked.name, why: `Open to everyone in ${picked.orgName}`,
        kind: 'picked' as const, handleSuggestions: picked.handle ? [picked.handle] : [],
        logo: picked.logo ?? null, orgName: picked.orgName, memberCount: picked.memberCount, inviteOnly: false,
      }] : []),
      // Live answers first: they carry logos, and the de-duplication below
      // keeps the first of each workspace.
      ...[...(live?.pendingJoins ?? []), ...invites].map(fromInvite),
      ...[...(live?.orgMatches ?? []), ...matches].map(fromMatch),
    ];
    const seen = new Set<string>();
    return all.filter(c => !seen.has(c.workspaceId) && (seen.add(c.workspaceId), true));
  }, [state.auth, live, picked]);

  // Coming from an org's page, the choice is already made: straight to the handle.
  const [chosen, setChosen] = useState<string | null>(picked?.workspaceId ?? null);
  const pick = candidates.find(c => c.workspaceId === chosen) ?? null;
  const [handles, setHandles] = useState<Record<string, string>>({});
  const handle = pick ? (handles[pick.workspaceId] ?? pick.handleSuggestions[0] ?? '') : '';
  const setHandle = (h: string) => { if (pick) setHandles(v => ({ ...v, [pick.workspaceId]: h })); };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return <p className="text-sm text-muted-foreground">Looking for your team…</p>;
  if (candidates.length === 0) {
    return state.auth.status === 'needs_workspace'
      ? <Navigate replace to="/onboarding/create" />
      : <p className="text-sm text-muted-foreground">
          Nothing to join right now. When someone invites you, or your company opens its
          organization to your email domain, it appears here.
        </p>;
  }

  const signInAgain = async () => {
    try { apply(await call(api => api.query('auth.signOut'))); }
    finally { void navigate('/signin', { replace: true }); }
  };

  const join = async () => {
    if (!pick) return;
    setBusy(true); setError(null);
    try {
      const s = await call(api => api.query('auth.join', { workspaceId: pick.workspaceId, handle }));
      if (s) {
        apply(s);
        void navigate(`/w/${pick.workspaceId}`, { replace: true });
      }
    } catch (e) {
      const msg = (e as Error).message;
      setError(isExpiredSignIn(msg) ? EXPIRED_SIGN_IN
        : Object.entries(REFUSALS).find(([code]) => msg.includes(code))?.[1] ?? msg);
    } finally { setBusy(false); }
  };


  // ── step 1: everywhere you could go ────────────────────────────────────────
  // Linear's structure: a title that names the company, one list, a Join per
  // row, and creating your own as the quiet alternative underneath.
  if (!pick) {
    const orgs = [...new Set(candidates.map(c => c.orgName))];
    return (
      <div className="space-y-8">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-medium">
            {orgs.length === 1 ? `Join a workspace at ${orgs[0]}` : 'Join a workspace'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Workspaces are where your team talks, shares work, and works with agents.
          </p>
        </div>

        <div className="space-y-2">
        <div className="flex justify-end">
          <CheckAgain prompt="Don't see your workspace?" />
        </div>
        <div className="divide-y overflow-hidden rounded-xl border">
          {candidates.map(c => (
            <div key={c.workspaceId} className="flex items-center gap-3 px-4 py-3">
              <Tile name={c.name} seed={c.workspaceId} logo={c.logo} />
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate font-medium">{c.name}</span>
                {c.inviteOnly && <LockClose className="size-3.5 shrink-0 text-muted-foreground" aria-label="Invite only" />}
                <span className="shrink-0 text-sm text-muted-foreground">
                  · {c.memberCount} {c.memberCount === 1 ? 'member' : 'members'}
                </span>
              </div>
              <Button size="sm" variant="secondary"
                      onClick={() => { setChosen(c.workspaceId); setError(null); }}>
                Join
              </Button>
            </div>
          ))}
        </div>
        </div>

        {/* Creating your own is a real alternative, not a footnote — but the
            second choice, so it sits under an "or" and is quieter than Join. */}
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="flex justify-center">
            <Link to="/onboarding/create" className={buttonVariants({ variant: 'outline' })}>
              Create a new workspace
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ── step 2: your handle there ──────────────────────────────────────────────
  return (
    <Card>
      <CardHeader>
        {candidates.length > 1 && (
          <button type="button" onClick={() => { setChosen(null); setError(null); }}
                  className="mb-1 w-fit text-sm text-muted-foreground hover:text-foreground">
            ← All workspaces
          </button>
        )}
        <div className="flex items-center gap-3">
          <Tile name={pick.name} seed={pick.workspaceId} logo={pick.logo} />
          <div className="min-w-0">
            <CardTitle className="truncate">Join {pick.name}</CardTitle>
            <CardDescription className="truncate">{pick.why}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not join</AlertTitle>
            <AlertDescription className="[overflow-wrap:anywhere]">
              {error}
              {error === EXPIRED_SIGN_IN && (
                <Button size="sm" variant="outline" className="mt-2" onClick={() => void signInAgain()}>
                  Sign in again
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label htmlFor="join-handle">Your handle in {pick.name}</Label>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">@</span>
            <Input id="join-handle" value={handle} autoFocus
                   onChange={(e) => setHandle(e.target.value.toLowerCase())} />
          </div>
          <p className="text-xs text-muted-foreground">
            Handles are per workspace, so one you use elsewhere may already be taken here.
          </p>
          {pick.handleSuggestions.length > 1 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {pick.handleSuggestions.map(sug => (
                <Button key={sug} size="sm" variant={sug === handle ? 'secondary' : 'ghost'}
                        onClick={() => setHandle(sug)}>@{sug}</Button>
              ))}
            </div>
          )}
        </div>

        <Button onClick={() => void join()} disabled={busy || handle.length < 3}>
          {busy ? 'Joining…' : `Join ${pick.name}`}
        </Button>
      </CardContent>
    </Card>
  );
}

/** A workspace's mark before you are in it: its logo, else initials on the colour its id derives. */
function Tile({ name, seed, logo }: { name: string; seed: string; logo: string | null }) {
  return (
    <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg text-sm font-medium
                     text-foreground/90"
          style={logo ? undefined : { backgroundColor: `oklch(0.34 0.07 ${hueFor(seed)})` }}>
      {logo ? <img src={logo} alt="" className="size-full object-contain" /> : initials(name)}
    </span>
  );
}
