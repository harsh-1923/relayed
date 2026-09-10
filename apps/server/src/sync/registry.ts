// Who is currently connected — step 6 of the sync build plan
// (docs/SYNC-FLOWS.md §2).
//
// THE REGISTRY HOLDS NO AUTHORIZATION. It is a map from an actor to the sockets
// they happen to have open, and nothing else. That is the entire architectural
// claim of this phase in one data structure: because a connection never records
// what it is entitled to receive, there is nothing to revoke when that changes.
// An event resolves its own audience from the database at send time, and a
// membership removed a millisecond ago is simply absent from the next answer.
//
// The alternative — a connection that remembers "this socket wants channel X" —
// is a subscription, and every system built that way needs revocation, and
// revocation needs a window in which it has not happened yet. We do not have
// that window because we do not have the record.
//
// THE REGISTRY IS MEMORY, NOT TRUTH. A crash empties it; clients reconnect and
// catch up. Nothing durable may ever depend on what is in here.
import type { WebSocket } from 'ws';

/**
 * One delivery target.
 *
 * Deliberately not "one connection": what fanout needs is somewhere to put
 * bytes and a way to tell whether that somewhere is keeping up. Keeping the
 * interface this narrow is what lets the whole of step 6 be tested without a
 * socket, and stops anything here reaching into transport state it should not.
 */
export interface Delivery {
  /** From the verified token. The key this is filed under. */
  readonly actorId: string;
  /**
   * Which workspace this connection is FOR.
   *
   * One actor may hold connections to several workspaces at once — separate
   * tokens, separate replicas — so an event has to be filtered by this as well
   * as by audience. Without it, an event from one tenant reaches a socket that
   * is authenticated for another, which is an access leak that no permission
   * check would catch, because delivery is not a permission check.
   */
  readonly workspaceId: string;
  /** Bytes queued and not yet flushed. The only signal a consumer is slow. */
  readonly backlog: number;
  send(t: string, body: Record<string, unknown>): void;
  /** End it. The client will reconnect and catch up. */
  drop(code: number, reason: string): void;
}

/**
 * KEYED BY ACTOR, NOT BY DEVICE.
 *
 * Alice on a laptop and a desktop is two entries under one id, and both receive
 * everything she may see. That is what makes multi-device work with no special
 * case anywhere else in the system — no "primary" connection, no de-duplication,
 * no question about which one gets the event.
 */
export class Registry {
  #byActor = new Map<string, Set<Delivery>>();

  add(delivery: Delivery): void {
    const existing = this.#byActor.get(delivery.actorId);
    if (existing) { existing.add(delivery); return; }
    this.#byActor.set(delivery.actorId, new Set([delivery]));
  }

  remove(delivery: Delivery): void {
    const set = this.#byActor.get(delivery.actorId);
    if (!set) return;
    set.delete(delivery);
    // Emptied rather than left behind. A map that only ever grows is a leak
    // whose symptom is memory, months later, on the busiest server.
    if (set.size === 0) this.#byActor.delete(delivery.actorId);
  }

  /**
   * Every open connection for these actors.
   *
   * Takes the whole audience at once rather than being called per actor,
   * because the caller has a set and the answer is a flat list of sockets —
   * and because iterating an audience of 1,600 through 1,600 calls is the kind
   * of thing that reads fine and profiles badly.
   */
  forActors(actorIds: Iterable<string>): Delivery[] {
    const out: Delivery[] = [];
    for (const actorId of actorIds) {
      const set = this.#byActor.get(actorId);
      if (set) out.push(...set);
    }
    return out;
  }

  /** Connections, not actors. Two devices for one person count as two. */
  size(): number {
    let total = 0;
    for (const set of this.#byActor.values()) total += set.size;
    return total;
  }

  /** Actors with at least one connection. The "who is online" number. */
  actors(): number { return this.#byActor.size; }
}

/** `ws`'s own view of how far behind a socket is. */
export const backlogOf = (socket: WebSocket): number => socket.bufferedAmount;
