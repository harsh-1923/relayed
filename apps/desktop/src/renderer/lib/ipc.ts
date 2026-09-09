// The renderer's only door to the sync engine.
//
// Everything goes through `call()`, for one reason: a reply superseded by a
// workspace switch is not a failure — it belongs to the workspace we just left
// (STORAGE.md §12.1). Normalised to null here so no call site has to remember.
//
// The marker rides on the RESOLVED VALUE rather than on an Error, because
// contextBridge strips custom properties off Errors. That cost a debugging
// session once; it is not rediscovered by keeping the check in one place.
import type { AppState, RelayedApi } from '../../preload/api';
import type { Grants, Role } from '@relayed/authz';

/**
 * The bridge, or undefined when the renderer runs standalone — `pnpm ui` opens
 * Vite without Electron, which is useful for pure layout work and has no
 * preload attached.
 */
export const bridge = (): RelayedApi | undefined =>
  (window as Window & { relayed?: RelayedApi }).relayed;

export async function call<T>(fn: (api: RelayedApi) => Promise<T>): Promise<T | null> {
  const api = bridge();
  if (!api) return null;
  const v = await fn(api);
  const key = api.STALE;
  if (key && v && typeof v === 'object' && key in v) return null;
  return v;
}

/**
 * Local bytes only — never the remote URL the server gave us. Served by main
 * over a custom scheme so `webSecurity` stays on and no filesystem path reaches
 * the DOM (DESIGN.md §13.3). Absent until the prefetch lands, which is what the
 * initials fallback is for.
 */
export const blobSrc = (id: string | null | undefined): string | undefined =>
  id ? `relayed-blob://${id}` : undefined;

/**
 * The client's mirror of the server's evaluator — the SAME function, from
 * @relayed/authz, not a second implementation that could drift (AUTHZ.md §12.2).
 *
 * It answers from replicated state and never touches the network, which is what
 * lets the UI be correct offline (§3). It may only HIDE a control it believes is
 * denied; the server re-checks every write regardless (invariant 49), so being
 * wrong here is an affordance that fails on use, not a permission granted.
 */
export const grantsOf = (state: AppState): Grants =>
  new Map(state.grants as [string, Role][]);

export const initials = (s: string): string =>
  s.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

/**
 * A stable colour per workspace, derived from its id.
 *
 * The rail exists to tell workspaces apart at a glance, and initials alone stop
 * doing that the moment two of them start with the same letter. Derived rather
 * than stored so it needs no schema and never disagrees between devices.
 */
export function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}
