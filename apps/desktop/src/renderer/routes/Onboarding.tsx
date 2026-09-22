// Account-tier layout: no workspace replica is open here, and nothing on these
// routes may read one (FRONTEND.md §4.6). Deliberately outside AppShell, so
// there is no rail suggesting a workspace context that does not exist.
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useSession } from '@/app/state';
import { call } from '@/lib/ipc';

export function Onboarding() {
  const { state, apply } = useSession();
  const navigate = useNavigate();
  const joins = state.auth.status === 'needs_workspace' ? state.auth.pendingJoins : [];
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

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background p-10 text-foreground">
      <div className="mx-auto max-w-xl space-y-6">
        <div>
          <h1 className="text-lg font-semibold">Relayed</h1>
          <p className="text-sm text-muted-foreground">
            {adding ? 'Set up the account you added'
              : returning ? 'Add another workspace' : 'One more step'}
          </p>
        </div>

        {joins.length > 0 && (
          <nav className="flex gap-1 border-b text-sm">
            {([['create', 'Create one'], ['join', `Join (${joins.length})`]] as const).map(([to, label]) => (
              <NavLink key={to} to={to} className={({ isActive }) =>
                `-mb-px border-b-2 px-3 py-2 ${isActive
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                {label}
              </NavLink>
            ))}
          </nav>
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
    </main>
  );
}
