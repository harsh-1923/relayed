// Holds the MessagePort and exposes a narrow API. The renderer never sees the
// port itself, and never sees anything resembling arbitrary SQL (§13.2).
import { contextBridge, ipcRenderer } from 'electron';

let port: MessagePort | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

// Queries can be issued before the port arrives; hold them until it does.
let markReady: () => void;
const ready = new Promise<void>((r) => { markReady = r; });

ipcRenderer.on('sync:port', (event) => {
  port = event.ports[0] ?? null;
  if (!port) return;
  port.onmessage = (e: MessageEvent) => {
    const msg = e.data as {
      id?: number; ok?: boolean; data?: unknown; error?: string;
      push?: string;
    };
    // Server-initiated pushes (auth state, and later invalidations) carry a
    // `push` name instead of a request id.
    if (msg.push) {
      for (const fn of subscribers.get(msg.push) ?? []) fn(msg.data);
      return;
    }
    if (typeof msg.id !== 'number') return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    msg.ok ? waiter.resolve(msg.data) : waiter.reject(new Error(msg.error ?? 'sync error'));
  };
  port.start();
  markReady();
});

// Re-attach on every load: this file re-runs on reload, and the previous port
// is already dead by then.
ipcRenderer.send('sync:attach');

const subscribers = new Map<string, Set<(data: unknown) => void>>();

const query = async (op: string, params?: unknown): Promise<unknown> => {
  await ready;
  if (!port) throw new Error('sync engine not attached');
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port!.postMessage({ id, op, params });
  });
};

function subscribe(channel: string, fn: (data: unknown) => void): () => void {
  const set = subscribers.get(channel) ?? new Set();
  set.add(fn);
  subscribers.set(channel, set);
  return () => { set.delete(fn); };
}

// Narrow surface only: no port, no tokens, no arbitrary SQL (§13.2).
contextBridge.exposeInMainWorld('relayed', { query, subscribe });
