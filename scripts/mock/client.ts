// One virtual client: a real replica, a real socket, the real engine.
//
// NOT A SIMULATION OF A CLIENT. It builds an in-memory SQLite replica with the
// real migrations, hands it to the real `createLink`, and lets it open a real
// WebSocket to a real server. Anything that mocked the engine would produce
// telemetry describing the mock — which is worth nothing, because the whole
// point of a load run is to see what the SHIPPED code reports.
//
// The only thing that is not real is the person: `send`, `goOffline` and
// `scrollBack` stand in for a UI that does not exist yet.
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../apps/desktop/src/sync/migrate.ts';
import { workspaceMigrations } from '../../apps/desktop/src/sync/migrations/workspace.ts';
import { createLink, type Link } from '../../apps/desktop/src/sync/link.ts';
import { enqueue, depth, failed, retry, discard } from '../../apps/desktop/src/sync/outbox.ts';
import { frontierOf, headOf } from '../../apps/desktop/src/sync/apply.ts';
import { backfillFloor } from '../../apps/desktop/src/sync/catchup.ts';
import { installNetworkGate } from '../../apps/desktop/src/sync/network.ts';
import { startSpan } from '@relayed/telemetry';
import { ulid } from '../../apps/server/src/db/ulid.ts';

const gate = installNetworkGate({ fetch: globalThis.fetch });
// Nothing here waits on a first paint, and leaving the gate closed would count
// every socket this run opens as an R3 violation — a number that means
// something specific and would become noise.
gate.markPaintable();

export interface ClientOptions {
  url: string;
  actorId: string;
  workspaceId: string;
  token(): Promise<string | null>;
}

export class MockClient {
  readonly actorId: string;
  readonly db: DatabaseSync;
  readonly link: Link;
  /** Chats this client has posted into, so a scroll-back has somewhere to go. */
  readonly seen = new Set<string>();
  #stopped = false;

  constructor(opts: ClientOptions) {
    this.actorId = opts.actorId;
    // In memory: a load run should not leave a hundred replica files behind,
    // and the disk shape is Phase 1's concern rather than sync's.
    this.db = new DatabaseSync(':memory:');
    migrate(this.db, workspaceMigrations);

    this.link = createLink({
      url: opts.url,
      gate,
      db: () => this.db,
      workspaceId: () => opts.workspaceId,
      token: opts.token,
      // The renderer is not part of this run. Invalidations are counted by the
      // engine's own markers; there is nothing mounted to wake.
      invalidate: () => {},
      onWelcome: (body) => {
        for (const chat of body.chats ?? []) this.seen.add(chat.id);
      },
    });
  }

  start(): void { this.link.start(); }

  /**
   * Type a message.
   *
   * Through `enqueue` and a drain, exactly as a compose surface will: the
   * optimistic row, the outbox entry and the trace context are all written in
   * one transaction, and the drain is what puts it on the wire. Calling the
   * socket directly would skip the half of the write path that has to survive
   * being offline.
   */
  send(chatId: string, body: string): string {
    const messageId = ulid('msg');
    // A span per composed message, which is what the server's `sync.op` span
    // becomes a child of. Fire-and-forget: the operation this opens is the
    // enqueue, and the SEND continues under the outbox's own span long after.
    void startSpan('ui.compose', () => {
      enqueue(this.db, {
        opId: ulid('op'), kind: 'send', chatId, targetId: messageId,
        payload: { body, parent_id: null },
      }, (db) => {
        db.prepare(`
          INSERT INTO messages (id, chat_id, parent_id, ord, rev, author_id, body,
                                created_at, state, local_only)
          VALUES (?, ?, NULL, NULL, 0, ?, ?, ?, 'pending', 0)
        `).run(messageId, chatId, this.actorId, body, Date.now());
      });
    }, { attributes: { chat_id: chatId, actor_id: this.actorId } });

    this.seen.add(chatId);
    this.link.drain();
    return messageId;
  }

  /** Delete something. Offline, this coalesces with its own send and never goes. */
  delete(chatId: string, messageId: string): void {
    void startSpan('ui.compose', () => {
      enqueue(this.db, {
        opId: ulid('op'), kind: 'delete', chatId, targetId: messageId, payload: {},
      });
    }, { attributes: { chat_id: chatId, op_kind: 'delete' } });
    this.link.drain();
  }

  /** Scroll to the floor of a chat and ask for what is under it. */
  scrollBack(chatId: string): boolean { return this.link.backfill(chatId); }

  /** Any chat this client holds a marked floor for — where a gap actually was. */
  gappedChat(): string | null {
    for (const chatId of this.seen) {
      if (backfillFloor(this.db, chatId).hasGap) return chatId;
    }
    return null;
  }

  /** The laptop shut. Nothing is lost; the outbox is on disk and the link stops. */
  goOffline(): void { this.link.stop(); }

  /**
   * And opened again. A fresh socket, a `hello` carrying wherever we got to.
   *
   * BOTH CALLS, because they cover different states and neither covers all of
   * them. `start` moves a link out of `idle` or `stopped`; a link sitting in
   * `backoff` ignores it entirely and waits out its delay — which is up to a
   * minute once the attempt count has climbed (invariant 31, working). A run
   * that only called `start` left a third of the fleet parked in backoff and
   * the whole thing plateaued at a fixed lag that looked exactly like a stall.
   *
   * `retryNow` is the "the laptop woke up" signal, and that is what this is.
   */
  goOnline(): void {
    if (this.#stopped) return;
    this.link.start();
    this.link.retryNow();
  }

  /** Retry or discard whatever failed permanently, the way a person would. */
  triage(): { retried: number; discarded: number } {
    let retried = 0, discarded = 0;
    for (const op of failed(this.db)) {
      // Two thirds give up, a third try again. A run where everybody retried
      // for ever would never produce a `discarded`, and that is a real outcome.
      if (Math.random() < 0.34) { retry(this.db, op.opId); retried++; }
      else { discard(this.db, op.opId); discarded++; }
    }
    if (retried > 0) this.link.drain();
    return { retried, discarded };
  }

  /** How far behind this client is, worst stream. What a stall would show as. */
  worstLag(): number {
    const rows = this.db.prepare(`
      SELECT MAX(server_head_rev - synced_through_rev) AS lag FROM stream_state
    `).get() as { lag: number | null };
    return rows.lag ?? 0;
  }

  queued(): number { return depth(this.db).queued; }

  /** What this client is doing, for a run that did not converge. */
  diagnose(): { actor: string; state: string; lag: number; queued: number; worst: string } {
    const row = this.db.prepare(`
      SELECT stream_kind, stream_id, server_head_rev - synced_through_rev AS lag
        FROM stream_state ORDER BY lag DESC LIMIT 1
    `).get() as { stream_kind: string; stream_id: string; lag: number } | undefined;
    return {
      actor: this.actorId.slice(-6),
      state: this.link.state,
      lag: row?.lag ?? 0,
      queued: this.queued(),
      worst: row ? `${row.stream_kind}:${row.stream_id.slice(-6)}` : '—',
    };
  }

  /**
   * Stop the link. Does NOT close the replica.
   *
   * `applyCatchup` yields between chunks, so a reply can still be part-applied
   * when the link stops — and closing the database underneath it is "database
   * is not open" from inside a setImmediate nobody is awaiting. In the real app
   * the replica outlives the link and this cannot happen; here the run closes
   * them together, afterwards, through `close`.
   */
  stop(): void {
    this.#stopped = true;
    this.link.stop();
  }

  close(): void { this.db.close(); }
}

/** Where a client has got to on one chat. Used to assert convergence at the end. */
export const cursorOf = (client: MockClient, chatId: string): { at: number; head: number } => ({
  at: frontierOf(client.db, { kind: 'chat', id: chatId }),
  head: headOf(client.db, { kind: 'chat', id: chatId }),
});
