// The gate every outbound call passes through.
//
// Extracted rather than left as a closure in the sync engine so it can be
// tested as a unit — the alternative was driving a whole Electron process over
// IPC to find out whether a boolean worked.
//
// Two jobs, and they have DIFFERENT lifetimes:
//
//   1. Counting calls made before the renderer could paint. An R3 violation is
//      not a slow boot, and an invariant checked only when somebody remembers
//      is not instrumented (OBSERVABILITY.md §9) — so this ships, always.
//   2. Simulated offline. A development affordance, and one that can disable
//      the network — so it must not exist in a packaged build at all, not
//      merely be unreachable in one.
//
// Hence two wrappers rather than one with a flag: `allowOffline: false` builds
// a closure that has no offline branch to execute or to reach.
//
// COST: below what the measurement can resolve. Repeated runs against an
// unwrapped function gave 8.5, -1.2 and 7.8 ns per call — a negative figure is
// impossible, so the noise exceeds the signal, and the honest statement is
// "under ~10 ns and indistinguishable from zero". Against roughly 1 ms for a
// loopback round trip that is at most one ten-thousandth of one call.
//
// Quoting a single run as though it were the number would have been the same
// mistake as trusting any other unrepeated measurement.
import { count } from '@relayed/telemetry';

export interface Gate {
  /** Everything before this is a call the read path did not need. */
  markPaintable(): void;
  /**
   * Cut or restore the network. A no-op unless `allowOffline` was set, so a
   * production build cannot be talked into it by an IPC message.
   */
  setOffline(on: boolean): void;
  /**
   * Told when the network is cut or restored. Returns an unsubscribe.
   *
   * WHY A NOTIFICATION AND NOT JUST A FLAG. `guardConnect` refuses to OPEN a
   * socket, which was the whole of "offline" when the only network calls were
   * fetches and nothing stayed connected. A long-lived WebSocket never asks
   * again: it is established, it does not go through `fetch`, and nothing was
   * closing it — so the app went on syncing with the aeroplane switch on.
   *
   * Cutting a live connection is something only its owner can do, so the gate
   * says WHEN and the transport decides HOW.
   */
  onOffline(listener: (offline: boolean) => void): () => void;
  readonly offline: boolean;
  /** True when this build can simulate offline at all. */
  readonly canGoOffline: boolean;
  /** Only populated when tracing; the counter is always on. */
  readonly callsBeforePaint: readonly string[];
  /** Restores the original fetch. Tests must not leak a patched global. */
  uninstall(): void;
}

export interface GateOptions {
  /** Record the URLs, not just the count. A debugging aid; the counter is not. */
  trace?: boolean;
  /** Development builds only. Omitted, the offline branch is not compiled in. */
  allowOffline?: boolean;
}

export function installNetworkGate(
  target: { fetch: typeof fetch }, opts: GateOptions = {},
): Gate {
  const real = target.fetch;
  const allowOffline = opts.allowOffline === true;
  let paintable = false;
  let offline = false;
  const before: string[] = [];
  const listeners = new Set<(offline: boolean) => void>();

  const countIfEarly = (args: Parameters<typeof fetch>): void => {
    if (paintable) return;
    count('boot.network_calls_before_paint');
    if (opts.trace) {
      const [input] = args;
      before.push(input instanceof Request ? input.url : String(input));
    }
  };

  target.fetch = (allowOffline
    ? (...args: Parameters<typeof fetch>) => {
        countIfEarly(args);
        // A TypeError, because that is what a real DNS or connect failure
        // produces and what the session's `stale` path already distinguishes
        // from a 401. Rejecting rather than throwing keeps the shape of fetch
        // intact for a caller that never awaits.
        if (offline) return Promise.reject(new TypeError('fetch failed'));
        return real(...args);
      }
    : (...args: Parameters<typeof fetch>) => {
        countIfEarly(args);
        return real(...args);
      }) as typeof fetch;

  return {
    markPaintable() { paintable = true; },
    setOffline(on: boolean) {
      if (!allowOffline || offline === on) return;
      offline = on;
      // A listener that throws must not stop the others hearing, and must not
      // leave the gate half-switched.
      for (const listener of listeners) {
        try { listener(on); } catch { /* a transport's problem, not the gate's */ }
      }
    },
    onOffline(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get offline() { return offline; },
    get canGoOffline() { return allowOffline; },
    get callsBeforePaint() { return before; },
    uninstall() { target.fetch = real; listeners.clear(); },
  };
}

/**
 * Ask the gate before opening a connection it cannot see.
 *
 * Patching `globalThis.fetch` catches fetch and NOTHING ELSE — a WebSocket is a
 * separate constructor, so the socket Phase 2 brings would slip past both jobs
 * above: a connection opened before first paint would go uncounted, and
 * simulated offline would be half a simulation, which is worse than none.
 *
 * The transport is not written yet, so this is the hook rather than the fix:
 * whatever opens that socket calls `guardConnect(gate)` first, and the two
 * behaviours stay in one place instead of being reimplemented per transport.
 */
export function guardConnect(gate: Gate, url: string): void {
  if (!gate.offline) return;
  throw new TypeError(`offline (simulated): refusing to connect to ${new URL(url).host}`);
}
