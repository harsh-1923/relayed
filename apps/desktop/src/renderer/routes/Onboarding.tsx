// Account-tier layout: no workspace replica is open here, and nothing on these
// routes may read one (FRONTEND.md §4.6). Deliberately outside AppShell, so
// there is no rail suggesting a workspace context that does not exist.
import { NavLink, Outlet } from 'react-router';
import { useSession } from '@/app/state';

export function Onboarding() {
  const { state } = useSession();
  const joins = state.auth.status === 'needs_workspace' ? state.auth.pendingJoins : [];
  const returning = state.workspaces.some(w => w.state === 'active');

  return (
    <main className="mx-auto min-h-svh max-w-xl space-y-6 bg-background p-10 text-foreground">
      <div>
        <h1 className="text-lg font-semibold">Relayed</h1>
        <p className="text-sm text-muted-foreground">
          {returning ? 'Add another workspace' : 'One more step'}
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
    </main>
  );
}
