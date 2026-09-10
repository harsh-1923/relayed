// The engine's end of the socket: routing frames into the replica.
//
// This module is where steps 5 to 10 of the sync plan actually meet. Everything
// before it was a piece with a test — a connection, an apply loop, a scheduler,
// a directory pager — and none of them had a caller. This is the caller.
//
// IT WAS NOT IN THE PLAN, which is worth recording rather than smoothing over.
// The plan assigned every piece and never assigned the assembly, so it was
// nobody's step until the directory forced it: `fetchActors` may only be
// deleted once its replacement is RUNNING, and the replacement runs here.
//
// Deliberately thin. Nothing here decides what an event means or how far behind
// a stream is — it decides which function gets called with what, and that is
// all. The moment it starts holding opinions it becomes a second place where
// the frontier rule lives.
import type { DatabaseSync } from 'node:sqlite';
import type { Welcome, DirectoryOk } from '@relayed/protocol';
import { Connection, type LinkState, type SocketLike } from './transport/connection.ts';
import type { Gate } from './network.ts';
import {
  applyEvent, type Envelope, type Stream, type Effect,
} from './apply.ts';
import { replicaEffect } from './effects.ts';
import {
  CatchupScheduler, applyCatchup, applyGap, applyDirectoryPage,
  directorySnapshotComplete, directoryOwed,
  type MessageRow, type DirectoryRow,
} from './catchup.ts';

export interface LinkDeps {
  url: string;
  gate: Gate;
  /** The replica for the workspace currently open, or null before one is. */
  db(): DatabaseSync | null;
  workspaceId(): string | null;
  token(): Promise<string | null>;
  /** Wake whatever the renderer has mounted. */
  invalidate(topics: string[]): void;
  /** Everything `welcome` carried, for storage to write. */
  onWelcome(body: Welcome): void;
  onState?(state: LinkState): void;
  onEvent?(name: string, detail?: Record<string, unknown>): void;
  /** Test seams, exactly as on the connection itself. */
  open?(url: string): SocketLike;
  effect?: Effect;
}

export interface Link {
  start(): void;
  stop(): void;
  /** Reconnect now — waking from sleep, or a freshly refreshed token. */
  retryNow(): void;
  readonly state: LinkState;
}

export function createLink(deps: LinkDeps): Link {
  const effect = deps.effect ?? replicaEffect(type =>
    deps.onEvent?.('sync.event.unknown', { type }));

  let scheduler: CatchupScheduler | null = null;
  /** Resolves the directory page currently in flight. One at a time. */
  let awaitingPage: ((page: DirectoryOk) => void) | null = null;

  const connection = new Connection({
    url: deps.url,
    gate: deps.gate,
    token: deps.token,
    ...(deps.open ? { open: deps.open } : {}),
    ...(deps.onState ? { onState: deps.onState } : {}),
    ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),

    // Where the replica says it has got to, read at CONNECT time rather than
    // held: after a long backoff the replica is somewhere else entirely.
    cursors: () => {
      const db = deps.db();
      if (!db) return [];
      return (db.prepare(`SELECT stream_kind, stream_id, synced_through_rev
                            FROM stream_state`).all() as {
        stream_kind: string; stream_id: string; synced_through_rev: number;
      }[]).map(row => ({
        kind: row.stream_kind, id: row.stream_id, rev: row.synced_through_rev,
      }));
    },

    onWelcome: (body) => {
      deps.onWelcome(body);
      const db = deps.db();
      if (!db) return;

      // The scheduler is rebuilt per connection, not kept across one. Its whole
      // state is "what have I asked for on THIS socket" — carrying it over a
      // reconnect would leave requests marked in-flight that nothing will ever
      // answer, and the streams behind them would never be asked about again.
      scheduler = new CatchupScheduler(db, (stream, fromRev) => {
        send('catchup', { stream: { kind: stream.kind, id: stream.id }, from_rev: fromRev });
      });
      scheduler.sweep();
      void hydrateDirectory();
    },

    onFrame: (t, body) => { route(t, body); },
  });

  function send(t: string, body: Record<string, unknown>): void {
    // Reaches into the connection's socket rather than exposing one, because a
    // general `send` on the connection would invite anything to write frames —
    // and the set of frames this client sends is small and belongs in one place.
    connection.send(t, body);
  }

  function route(t: string, body: unknown): void {
    const db = deps.db();
    if (!db) return;

    if (t === 'ev') {
      const frame = body as { stream: Stream; rev: number; type: string; payload: unknown };
      const result = applyEvent({ db, effect }, frame.stream,
        { rev: frame.rev, type: frame.type, payload: frame.payload });
      if (result.topics.length > 0) deps.invalidate(result.topics);
      // ONE coalesced request, decided here rather than per staged event. A
      // client a hundred events behind sees a hundred arrivals and the answer
      // to all of them is the same range.
      if (result.needsCatchup) scheduler?.want(frame.stream);
      return;
    }

    if (t === 'catchup_ok') {
      const frame = body as {
        stream: Stream; events: Envelope[]; complete: boolean;
      };
      void applyCatchup({ db, effect }, frame.stream, frame.events).then(result => {
        if (result.topics.length > 0) deps.invalidate(result.topics);
        // Settled AFTER applying, so the scheduler's "am I still behind" reads
        // a frontier that has already moved. Settling first would ask again for
        // a range that was about to be applied.
        scheduler?.settled(frame.stream);
      });
      return;
    }

    if (t === 'gap') {
      const frame = body as {
        stream: Stream; head_rev: number;
        snapshot: { kind: string; headOrd?: number; recent?: MessageRow[] };
      };
      deps.onEvent?.('sync.gap.entered', { kind: frame.stream.kind });
      deps.invalidate(applyGap(db, frame.stream, frame.head_rev, frame.snapshot));
      // The directory's gap is not repaired by the gap frame — it says only
      // that a paged snapshot is owed.
      if (frame.stream.kind === 'workspace') void hydrateDirectory();
      scheduler?.settled(frame.stream);
      return;
    }

    if (t === 'directory_ok') {
      const resolve = awaitingPage;
      awaitingPage = null;
      resolve?.(body as DirectoryOk);
      return;
    }
  }

  /**
   * Page the directory, and invalidate after EACH page.
   *
   * On a fresh device the first page is the difference between every author
   * being a monogram and most of them having a name, and it lands seconds
   * before the last one. Invalidating once at the end would hold that back for
   * no reason.
   */
  async function hydrateDirectory(): Promise<void> {
    const db = deps.db();
    const workspaceId = deps.workspaceId();
    if (!db || !workspaceId || !directoryOwed(db, workspaceId)) return;

    let after: string | null = null;
    for (;;) {
      const page = await requestPage(after);
      if (!page) return;                       // the socket went away mid-fetch
      deps.invalidate(applyDirectoryPage(db, workspaceId, page.rows as DirectoryRow[]));
      deps.onEvent?.('sync.directory.page', { rows: page.rows.length });

      if (page.complete || page.next_after_id === null) {
        // Only after the LAST page. Adopting the cursor earlier would leave the
        // client believing it held a directory it had only started fetching,
        // and every actor on later pages missing until they happened to change.
        directorySnapshotComplete(db, workspaceId, page.head_rev);
        return;
      }
      after = page.next_after_id;
    }
  }

  /** One page, or null if the connection went away while waiting. */
  function requestPage(afterId: string | null): Promise<DirectoryOk | null> {
    return new Promise(resolve => {
      let settled = false;
      awaitingPage = (page) => { if (!settled) { settled = true; resolve(page); } };
      send('directory', { after_id: afterId });
      // A DEADLINE, because every state that waits on the outside world carries
      // one (invariant 64). Without it a reply that never comes leaves this
      // promise — and the pager awaiting it — pending for the life of the
      // process.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        awaitingPage = null;
        deps.onEvent?.('sync.directory.timeout');
        resolve(null);
      }, 15_000);
      timer.unref?.();
    });
  }

  return {
    start: () => { connection.start(); },
    stop: () => {
      // The pager may be waiting on a page that will never arrive now. Settling
      // it is the difference between a stopped link and a stopped link holding
      // a promise nobody will resolve (invariant 54).
      const waiting = awaitingPage;
      awaitingPage = null;
      waiting?.({ rows: [], next_after_id: null, complete: true, head_rev: 0 });
      scheduler = null;
      connection.stop();
    },
    retryNow: () => { connection.retryNow(); },
    get state() { return connection.state; },
  };
}
