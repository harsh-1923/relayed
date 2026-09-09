// The workspace rail.
//
// Drawn entirely from account.db, so it is correct on a cold boot with no
// network and before any authentication (STORAGE.md §6, §11).
//
// It NAVIGATES. It does not call workspace.switch — that is invariant 56, and
// it is the whole reason the workspace can live in the URL without two things
// owning which one is active (FRONTEND.md §4.5). The gate downstream turns the
// URL into a switch.
import { Link, useLocation } from 'react-router';
import type { WorkspaceRow } from '../../preload/api';
import { useSession } from './state';
import { blobSrc, hueFor, initials } from '@/lib/ipc';

/**
 * Highlight what the URL asks for, not what the engine has finished opening.
 * A switch resolves in milliseconds but not instantly, and highlighting the
 * engine's answer makes the click feel like it was ignored.
 */
const routedWorkspace = (pathname: string): string | null =>
  /^\/w\/([^/]+)/.exec(pathname)?.[1] ?? null;

export function WorkspaceRail() {
  const { state } = useSession();
  const routed = routedWorkspace(useLocation().pathname);
  const workspaces = state.workspaces.filter(w => w.state === 'active');

  return (
    <nav className="flex w-16 shrink-0 flex-col items-center gap-2 border-r bg-sidebar py-3"
         aria-label="Workspaces">
      {workspaces.map((w: WorkspaceRow) => {
        const active = w.workspaceId === routed;
        // The WORKSPACE's identity, never the member's — the field names make
        // that hard to get wrong now (invariant 47). A workspace image is
        // optional and usually absent; initials on a derived colour are the
        // fallback, and a perfectly good one.
        return (
          <Link key={w.workspaceId} to={`/w/${w.workspaceId}`}
                title={`${w.name} · @${w.actorHandle}`}
                aria-current={active ? 'page' : undefined}
                style={{ backgroundColor: active || w.workspaceAvatarBlob ? undefined
                  : `oklch(0.34 0.07 ${hueFor(w.workspaceId)})` }}
                className={`relative grid size-10 place-items-center overflow-hidden rounded-xl
                  text-sm font-medium transition-[opacity,box-shadow] ${active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-foreground/85 opacity-80 hover:opacity-100'}`}>
            {w.workspaceAvatarBlob
              ? <img src={blobSrc(w.workspaceAvatarBlob)} alt="" className="size-full object-cover" />
              : initials(w.name)}
            {w.mentionHint > 0 && (
              <span className="absolute -right-0.5 -top-0.5 grid size-4 place-items-center
                               rounded-full bg-destructive text-[10px] text-white">
                {w.mentionHint > 9 ? '9+' : w.mentionHint}
              </span>
            )}
            {/* Writes parked here while another workspace is active
                (STORAGE.md §15.2). */}
            {w.outboxHint > 0 && (
              <span title={`${w.outboxHint} unsent`}
                    className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-amber-500" />
            )}
          </Link>
        );
      })}

      {/* Creating a workspace is an ACCOUNT-tier act — it opens no replica and
          needs none — so it lives outside /w/ (§4.6). */}
      <Link to="/onboarding/create" title="New workspace"
            className="grid size-10 place-items-center rounded-xl border border-dashed
                       text-muted-foreground hover:bg-accent hover:text-accent-foreground">
        +
      </Link>

      <div className="mt-auto">
        <Link to="/account" title="Account"
              className="grid size-10 place-items-center rounded-xl text-muted-foreground
                         hover:bg-accent hover:text-accent-foreground">
          ⌄
        </Link>
      </div>
    </nav>
  );
}
