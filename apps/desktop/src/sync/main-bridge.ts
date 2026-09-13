// Request/response over the parentPort to the main process, for the few
// capabilities a utilityProcess does not have: safeStorage (verified absent)
// and shell.openExternal.
let seq = 0;
const waiting = new Map<number, (v: unknown) => void>();

process.parentPort.on('message', (e) => {
  const m = e.data as { rid?: number; value?: unknown };
  if (typeof m?.rid === 'number') {
    waiting.get(m.rid)?.(m.value);
    waiting.delete(m.rid);
  }
});

export function callMain<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const rid = ++seq;
  return new Promise<T>((resolve) => {
    waiting.set(rid, (v) => resolve(v as T));
    process.parentPort.postMessage({ type, rid, ...payload });
  });
}

/**
 * One slot per (account, workspace) — STORAGE.md §9. The ids travel with every
 * call rather than being bound once, because the active workspace changes
 * underneath this and a stale binding would read the wrong slot.
 */
export const vault = {
  read:  (accountId: string, workspaceId: string) =>
    callMain<string | null>('vault:read', { accountId, workspaceId }),
  store: (accountId: string, workspaceId: string, token: string) =>
    callMain<void>('vault:store', { accountId, workspaceId, token }),
  clear: (accountId: string, workspaceId: string) =>
    callMain<void>('vault:clear', { accountId, workspaceId }),
};

export const openBrowser = (url: string) => callMain<void>('browser:open', { url });

/** Ask the person to choose a folder. `dialog` is a main-process API. Null when they cancel. */
export const pickFolder = () => callMain<string | null>('dialog:folder');

/** Scopes the relayed-blob: handler to one account (DESIGN.md §13.3). */
export const setBlobAccount = (accountId: string | null) =>
  callMain<void>('blob:account', { accountId });

/**
 * Apply the theme preference (PREFERENCES.md §9).
 *
 * `nativeTheme` is a main-process API and the preference lives in a database
 * only this process opens, so main is TOLD rather than deriving it — the same
 * split as `blob:account`, and for the same reason: a second reader of
 * account.db would be a second authority over it.
 *
 * One value drives both the native window material and `prefers-color-scheme`
 * in the renderer, which is what stops a dark interface appearing inside a
 * light-material window.
 */
export const setThemeSource = (source: 'system' | 'light' | 'dark') =>
  callMain<void>('theme:source', { source });

/**
 * Tell main the menu's Relayed items and their current bindings
 * (SHORTCUTS.md §6.3). Same split as the theme: the rows live in a database only
 * this process opens, and the menu is a main-process object.
 */
export const setMenuShortcuts = (items: readonly unknown[]) =>
  callMain<void>('shortcuts:menu', { items });
