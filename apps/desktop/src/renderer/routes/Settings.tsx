import { NavLink, Outlet } from 'react-router';
import { useSession } from '@/app/state';

export function Settings() {
  const { state } = useSession();
  const active = state.workspaces.find(w => w.workspaceId === state.workspaceId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">{active?.name}</p>
      </div>

      <nav className="flex gap-1 border-b text-sm">
        {([['members', 'Members'], ['agents', 'Agents'], ['profile', 'Your profile']] as const).map(([to, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) =>
            `-mb-px border-b-2 px-3 py-2 ${isActive
              ? 'border-primary font-medium text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
