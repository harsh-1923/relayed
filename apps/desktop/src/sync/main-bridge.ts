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

export const vault = {
  read:  () => callMain<string | null>('vault:read'),
  store: (token: string) => callMain<void>('vault:store', { token }),
  clear: () => callMain<void>('vault:clear'),
};

export const openBrowser = (url: string) => callMain<void>('browser:open', { url });
