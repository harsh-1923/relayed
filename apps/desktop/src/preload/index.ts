// Holds the MessagePort and exposes a narrow API. The renderer never sees the
// port itself, and never sees anything resembling arbitrary SQL (§13.2).
import { contextBridge, ipcRenderer } from 'electron';
import { isNativeCommandId, type NativeCommandId } from '../shared/shortcuts/catalogue.ts';

let port: MessagePort | null = null;
let nextId = 1;
/**
 * The active workspace generation (STORAGE.md §12.1, invariant 41).
 *
 * A query issued against the previous workspace can still be in flight when a
 * switch lands. Enforced HERE rather than in the renderer, so every consumer
 * gets it for free and no future component can forget.
 */
let epoch = 0;
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
      push?: string; epoch?: number;
    };
    // Server-initiated pushes (app state, and later invalidations) carry a
    // `push` name instead of a request id.
    if (msg.push) {
      const pushed = (msg.data as { epoch?: number } | undefined)?.epoch;
      if (typeof pushed === 'number' && pushed > epoch) epoch = pushed;
      for (const fn of subscribers.get(msg.push) ?? []) fn(msg.data);
      return;
    }
    if (typeof msg.id !== 'number') return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;

    if (typeof msg.epoch === 'number') {
      if (msg.epoch > epoch) epoch = msg.epoch;
      else if (msg.epoch < epoch) {
        // A reply for the workspace we have already left. Delivering it would
        // paint the previous workspace's data under the new one's chrome —
        // invisible in testing, and impossible to reproduce on demand.
        //
        // Resolved, never rejected: it is a non-result, not a failure, and the
        // caller's `finally` still has to run or the UI keeps a spinner up.
        pending.delete(msg.id);
        waiter.resolve({ [STALE]: true });
        // Invariant 41. The preload is the only place that knows a reply was
        // superseded, so it reports it rather than counting it — the telemetry
        // SDK lives in the sync process (OBSERVABILITY.md §3).
        port?.postMessage({ id: -1, op: 'telemetry.staleDropped' });
        return;
      }
    }

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

/**
 * Marks a reply superseded by a workspace switch.
 *
 * Carried as a PROPERTY ON THE RESOLVED VALUE, not as a rejection. contextBridge
 * clones an Error's message and stack and drops every custom own property, so a
 * `code` set here arrives in the renderer as an ordinary failure and gets shown
 * to the user — which is exactly what happened. A plain object survives the
 * structured clone intact.
 */
const STALE = '__stale';

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

/**
 * A command chosen from the application menu (SHORTCUTS.md §6.5).
 *
 * Only a command ID crosses, and only one on the menu's allow-list: main cannot
 * make the renderer execute an arbitrary string, and the renderer never
 * receives `ipcRenderer`. The listener is removed by the returned function, so a
 * provider remounted by a reload does not execute a command twice.
 */
function onCommand(fn: (id: NativeCommandId) => void): () => void {
  const listener = (_event: unknown, id: unknown) => {
    if (isNativeCommandId(id)) fn(id);
  };
  ipcRenderer.on('command:invoke', listener);
  return () => { ipcRenderer.removeListener('command:invoke', listener); };
}

// Narrow surface only: no port, no tokens, no arbitrary SQL (§13.2).
contextBridge.exposeInMainWorld('relayed', { query, subscribe, onCommand, STALE });
