// Account-tier layout: no workspace replica is open here, and nothing on these
// routes may read one (FRONTEND.md §4.6). Deliberately outside AppShell, so
// there is no rail suggesting a workspace context that does not exist.
import { NavLink, Outlet, useMatch, useNavigate } from 'react-router';
import { useSession } from '@/app/state';
import { call } from '@/lib/ipc';

export function Onboarding() {
  const { state, apply } = useSession();
  const navigate = useNavigate();
  // The join list carries its own title, Linear-style; the create form keeps the
  // app's header. No tabs: the list ends in "Or create one", and the create
  // form says when your team is already here.
  const onJoin = useMatch('/onboarding/join') !== null;
  // An account added from the switcher that has no workspace yet. The open
  // account is still open underneath — its workspaces are in `state` — so this
  // is not "returning", and "Back" has to put that account back, not just
  // navigate: "/" would route straight here again while this is pending.
  const adding = state.addingAccount === 'onboarding';
  const returning = !adding && state.workspaces.some(w => w.state === 'active');

  const cancelAdd = async () => {
    try { apply(await call(api => api.query('auth.cancelAddAccount'))); }
    finally { void navigate('/', { replace: true }); }
  };

  // "Check again" lives with what it refreshes — above the join list, above
  // the create form (features/identity/CheckAgain) — not down here.
  const onboarding = state.auth.status === 'needs_workspace';
  const email = state.auth.status === 'needs_workspace' ? state.auth.identity.email : '';

  // The way off this screen that is not quitting the app: another account, or
  // a sign-in that has expired. Not offered mid add-account, where "Back to your
  // account" is the exit and signing out would take the open account too.
  const signOut = async () => {
    try { apply(await call(api => api.query('auth.signOut'))); }
    finally { void navigate('/signin', { replace: true }); }
  };

  const footerLink = 'rounded-sm underline-offset-4 hover:text-foreground hover:underline '
    + 'focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60';

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background px-10 pt-10 pb-6 text-foreground">
      {/* The choice sits in the middle of the window, Linear-style; the footer
          stays at the foot. `flex-1` + `justify-center` centres it in the space
          above the footer, and a tall list simply scrolls. */}
      <div className="flex flex-1 flex-col justify-center">
      <div className="mx-auto w-full max-w-xl space-y-6">
        {!onJoin && (
          <div>
            <h1 className="text-lg font-semibold">Relayed</h1>
            <p className="text-sm text-muted-foreground">
              {adding ? 'Set up the account you added'
                : returning ? 'Add another workspace' : 'One more step'}
            </p>
          </div>
        )}

        <Outlet />

        {returning && (
          <NavLink to="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back
          </NavLink>
        )}
        {adding && (
          <button type="button" onClick={() => void cancelAdd()}
                  className="text-sm text-muted-foreground hover:text-foreground">
            ← Back to your account
          </button>
        )}
      </div>
      </div>

      {/* Who you are, and the way out — quiet, at the foot of the window, out of
          the way of the choice being made. */}
      {onboarding && (
        <footer className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pt-12
                           text-xs text-muted-foreground">
          {email && <span>Signed in as <span className="text-foreground/80">{email}</span></span>}
          {email && !adding && <span aria-hidden>·</span>}
          {!adding && (
            <button type="button" onClick={() => void signOut()} className={footerLink}>
              Sign out
            </button>
          )}
        </footer>
      )}
    </main>
  );
}
