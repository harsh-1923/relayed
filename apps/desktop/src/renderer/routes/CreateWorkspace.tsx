import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useSession } from '@/app/state';
import { WorkspaceForm } from '@/features/identity/WorkspaceForm';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { EXPIRED_SIGN_IN, isExpiredSignIn } from '@/lib/onboarding';
import { CheckAgain } from '@/features/identity/CheckAgain';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';

export function CreateWorkspace() {
  const { state, apply } = useSession();
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // A first workspace can pre-fill from the identity WorkOS gave us; an
  // additional one has nothing to pre-fill from, and guessing would be worse
  // than an empty field.
  const first = state.auth.status === 'needs_workspace' ? state.auth : null;

  // `?org=` — another workspace inside an org, from the switcher, for its
  // admins. The org is named from account.db; the server decides whether the
  // caller may (ORG-DOMAINS.md §7.1).
  const [params] = useSearchParams();
  const orgId = first ? null : params.get('org');
  const inOrg = orgId ? state.workspaces.find(w => w.orgId === orgId && w.state === 'active') : undefined;

  // A company that turned up since sign-in — found by "Check again" —
  // is the better choice, so say so above the form rather than only in a tab.
  const joinable = first ? first.pendingJoins.length + first.orgMatches.length : 0;
  const signInAgain = async () => {
    try { apply(await call(api => api.query('auth.signOut'))); }
    finally { void navigate('/signin', { replace: true }); }
  };

  return (
    <div className="space-y-4">
    {joinable === 0 && <CheckAgain prompt="Expecting your team here?" />}
    {joinable > 0 && (
      <Alert>
        <AlertTitle>Your team is already on Relayed</AlertTitle>
        <AlertDescription>
          People from your company have a workspace you can join.{' '}
          <Link to="/onboarding/join" className="font-medium text-foreground underline underline-offset-4">
            See where you can join
          </Link>
        </AlertDescription>
      </Alert>
    )}
    <Card>
      <CardHeader>
        <CardTitle>
          {first ? 'Name your workspace' : inOrg ? `New workspace in ${inOrg.orgName}` : 'New organization'}
        </CardTitle>
        <CardDescription>
          {first
            ? `Signed in as ${first.identity.email}. Your workspace starts its own organization; ` +
              'invite people to it, or let everyone with your company email join.'
            : inOrg
              ? `Open to everyone in ${inOrg.orgName} — they can find it and join. You can make it invite-only afterwards.`
              : 'A separate organization with its own workspace, members and local replica. Your handle here can differ.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not create it</AlertTitle>
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
        <WorkspaceForm
          orgId={inOrg?.orgId}
          defaultName={first?.identity.displayName
            ? `${first.identity.displayName}'s workspace` : ''}
          // In an org you are already in, the handle you use there is the
          // likeliest one you want — and a new workspace has an empty namespace.
          suggestions={first?.handleSuggestions ?? (inOrg ? [inOrg.actorHandle] : [])}
          submitLabel="Create workspace"
          onError={(m) => setError(m && isExpiredSignIn(m) ? EXPIRED_SIGN_IN : m)}
          onDone={(s) => {
            apply(s);
            // The engine made it active; the URL follows, because the URL is
            // where "which workspace" is expressed (§4.5).
            if (s.workspaceId) void navigate(`/w/${s.workspaceId}`, { replace: true });
          }} />
      </CardContent>
    </Card>
    </div>
  );
}
