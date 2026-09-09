// The one place AppState enters the renderer.
//
// It arrives two ways and both matter: a query at mount, and a push thereafter.
// Sign-in completes in the browser and a switch resolves its token after the
// repaint, so state that only ever arrived as a return value would be wrong
// within seconds of the app opening.
//
// This is NOT a store (FRONTEND.md §3). It holds no state of its own — it
// mirrors what the sync engine says is true, and `apply` exists only so a
// command's authoritative reply can land without waiting for the push that
// follows it.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import type { AppState } from '../../preload/api';
import { bridge } from '@/lib/ipc';

interface Session {
  state: AppState;
  /** Apply a command's reply. Null (a superseded reply) is ignored. */
  apply: (s: AppState | null) => void;
}

const Ctx = createContext<Session | null>(null);

export function AppStateProvider(props: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [attached, setAttached] = useState(bridge() !== undefined);

  useEffect(() => {
    const api = bridge();
    if (!api) { setAttached(false); return; }
    setAttached(true);
    void api.query('app.state').then(setState);
    return api.subscribe('app:state', setState);
  }, []);

  // Stable, so effects that depend on it do not re-run every render — the
  // workspace gate is one, and re-running it would re-issue a switch.
  const apply = useCallback((s: AppState | null) => { if (s) setState(s); }, []);
  const value = useMemo(() => (state ? { state, apply } : null), [state, apply]);

  if (!attached) {
    return (
      <main className="p-10 text-sm text-muted-foreground">
        Standalone renderer — the sync engine is not attached.
      </main>
    );
  }
  // Deliberately not a spinner. The first paint comes from disk and is fast
  // (R3); a spinner here would be visible only when something is wrong, and
  // would make that look normal.
  if (!value) return <main className="min-h-svh bg-background" />;

  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

export function useSession(): Session {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside AppStateProvider');
  return v;
}

/** The active workspace row, or null. Used often enough to be worth naming. */
export function useActiveWorkspace() {
  const { state } = useSession();
  return state.workspaces.find(w => w.workspaceId === state.workspaceId) ?? null;
}
