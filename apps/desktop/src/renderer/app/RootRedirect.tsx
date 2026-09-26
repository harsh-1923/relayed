// "/" is a decision, not a page.
//
// Where you belong is a function of state the engine owns, so this reads it and
// redirects rather than rendering anything of its own. `replace` throughout:
// landing on "/" should never become a history entry you can go back to, or
// back-navigation bounces you forward again.
import { Navigate } from 'react-router';
import { useSession } from './state';

export function RootRedirect() {
  const { state } = useSession();

  if (state.auth.status === 'needs_workspace') {
    // An invited person has no workspace of their own, and pushing them into
    // creating one reads as a broken invite (PHASE-1-IDENTITY §9). The same for
    // someone whose company is already here: their team comes first, creating
    // a separate org second (ORG-DOMAINS.md §7.2).
    const joinable = state.auth.pendingJoins.length + state.auth.orgMatches.length;
    return <Navigate replace to={joinable > 0 ? '/onboarding/join' : '/onboarding/create'} />;
  }

  // `stale` still has replicas on disk and still renders — that is the whole
  // point of R3, so it routes exactly like `authenticated`.
  const target = state.workspaceId ?? state.workspaces.find(w => w.state === 'active')?.workspaceId;
  if (target) return <Navigate replace to={`/w/${target}`} />;

  return <Navigate replace to="/signin" />;
}
