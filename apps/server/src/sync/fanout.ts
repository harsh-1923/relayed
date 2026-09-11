// Who receives an event, and how it reaches them — step 6 of the sync build
// plan (docs/SYNC-FLOWS.md §2, §7).
//
// THE INVERSION THIS FILE EXISTS FOR. Every other design in this space has the
// transport hold a subscription: a client asks for a stream, the server records
// that, and when the client stops being entitled to it, that record has to be
// found and revoked. Generation counters, subscription registries and
// revocation windows all exist to manage the gap between "no longer entitled"
// and "record removed".
//
// We do not have that gap, because we do not have the record. An event computes
// its own audience, from the database, in the moment it is delivered. A member
// removed a millisecond ago is simply absent from the answer — no revocation
// step, nothing to rotate, no window in which a stale audience is published to.
//
// The cost is one membership query per event. At team scale that is a few
// hundred an hour. If it ever matters, memoise space → members in this process
// and invalidate on a membership write. Do NOT cache it on the connection: a
// connection that remembers its audience is a subscription, and everything
// above stops being true.
import type { Kysely } from 'kysely';
import type { AppendedEvent } from './events.ts';
import type { DB } from '../db/schema.ts';
import { CLOSE } from '@relayed/protocol';
import type { Delivery, Registry } from './registry.ts';
import { spaceMembers, chatMembers, workspaceMembers } from './spaces.ts';
import { startSpan, annotate, mark } from '@relayed/telemetry';
import { recordAppend, recordFanout, recordSlowConsumer } from './observe.ts';

/**
 * How far behind a socket may fall before it is closed.
 *
 * A SLOW CONSUMER IS DROPPED, NOT BUFFERED, and that is only safe because
 * durable catch-up exists. A system without it would have to choose between
 * buffering without bound — one stuck client taking the server's memory with
 * it — and dropping the event silently, which is a permanent hole nobody
 * notices. We can close the socket precisely because everything it missed is
 * still in the log, and reconnecting replays it.
 *
 * A megabyte is a few thousand frames at the sizes we have measured. A client
 * that far behind is not going to catch up by being sent more; it is going to
 * catch up by asking for a range. The number is a starting point rather than a
 * finding — the open question about it is still open.
 */
export const BACKLOG_LIMIT_BYTES = 1_000_000;

export interface FanoutResult {
  /** Actors entitled to this event, connected or not. The metric that matters. */
  audience: number;
  /** Sockets actually written to. */
  delivered: number;
  /** Sockets closed for falling too far behind. */
  dropped: number;
}

/**
 * Everyone entitled to see this event.
 *
 * Entitlement, not presence — this answers "who may", and the registry answers
 * "who is here". Keeping them apart is what makes the audience a property of
 * the event rather than of who happens to be online.
 */
export async function audienceFor(
  db: Kysely<DB>, event: AppendedEvent,
): Promise<string[]> {
  switch (event.stream.kind) {
    case 'chat': {
      const chat = await db.selectFrom('chats')
        .select(['space_id', 'kind'])
        .where('id', '=', event.stream.id)
        .executeTakeFirst();
      // A chat that no longer exists has no audience. Failing closed is the
      // right direction: the alternative is guessing, and a wrong guess here
      // sends a message to somebody who cannot see the chat it belongs to.
      if (!chat) return [];

      const members = await spaceMembers(db, chat.space_id);
      if (chat.kind !== 'private') return members;

      // THE ACCESS PREDICATE, with the space conjunct LEADING — exactly as
      // `can()` evaluates it (invariant 50). The order is the whole point: an
      // actor removed from the space is filtered out here even if their chat
      // membership row was never tombstoned, so a stale row grants nothing.
      // Written the other way round — chat members narrowed by space — the same
      // set comes out today and the wrong one comes out the day a row is
      // missed.
      const inChat = new Set(await chatMembers(db, event.stream.id));
      return members.filter(actorId => inChat.has(actorId));
    }

    case 'space':
      return spaceMembers(db, event.stream.id);

    // The actor directory, and the only stream for which "everyone in the
    // workspace" is the right answer — earned because every member is entitled
    // to ALL of it, so no recipient ends up with a cursor full of holes.
    case 'workspace':
      return workspaceMembers(db, event.stream.id);
  }
}

/**
 * Resolve the audience and write the event to whoever is connected.
 *
 * CALLED AFTER COMMIT, NEVER INSIDE THE TRANSACTION. Inside, a rollback would
 * have already published something that never happened — and unlike most bugs
 * of that shape, nothing afterwards looks wrong: the clients hold an event the
 * database does not, and the next catch-up will not correct them because
 * catch-up returns what was written rather than what was sent.
 *
 * That ordering is why the domain ops RETURN their event instead of delivering
 * it. `ops.ts` still knows nothing about sockets; it reports what happened, and
 * this decides who hears about it.
 */
export async function fanout(
  db: Kysely<DB>, registry: Registry, event: AppendedEvent,
): Promise<FanoutResult> {
  return startSpan('sync.fanout', () => deliver(db, registry, event), {
    attributes: {
      stream_kind: event.stream.kind, stream_id: event.stream.id,
      event_type: event.type, rev: event.rev,
    },
  });
}

async function deliver(
  db: Kysely<DB>, registry: Registry, event: AppendedEvent,
): Promise<FanoutResult> {
  const started = performance.now();
  // Counted HERE rather than in `appendEvent`, and the difference is not
  // pedantic: an append runs inside the transaction that produced it, so
  // counting there would count writes that rolled back. Fanout is the first
  // point at which the event is known to have committed.
  recordAppend(event.stream.kind);
  const audience = await audienceFor(db, event);
  const targets = registry.forActors(audience);
  // Marked rather than made a child span: resolving the audience is a moment
  // inside one delivery, and a span per moment would triple the span count of
  // the busiest path in the system to record three timestamps.
  mark('audience.resolved', { actors: audience.length });

  let delivered = 0;
  let dropped = 0;
  for (const target of targets) {
    // The tenant check, and it is not redundant with the audience. One actor
    // may hold connections to several workspaces at once, and the audience is
    // a set of ACTORS — so without this an event from one workspace reaches a
    // socket authenticated for another.
    if (target.workspaceId !== event.workspaceId) continue;

    if (target.backlog > BACKLOG_LIMIT_BYTES) {
      target.drop(CLOSE.slowConsumer, 'too far behind');
      // Counted HERE as well as by the socket's own close path, because this is
      // the only place that knows the drop was a fanout decision rather than a
      // client going away.
      recordSlowConsumer();
      dropped++;
      continue;
    }

    target.send('ev', {
      stream: { kind: event.stream.kind, id: event.stream.id },
      rev: event.rev,
      type: event.type,
      payload: event.payload,
    });
    delivered++;
  }

  recordFanout(event.stream.kind, audience.length, dropped,
               performance.now() - started);
  annotate({ audience: audience.length, delivered, dropped });
  return { audience: audience.length, delivered, dropped };
}

/**
 * Deliver straight to one actor's connections, with no audience to resolve.
 *
 * For everything addressed to an ACTOR rather than ordered within a stream —
 * read state arriving from their other device, a counter snapshot. None of it
 * is a `sync_event`, none of it takes a revision, and a missed push is repaired
 * by the next `welcome` because a max-register cannot be applied wrongly by
 * being applied late (docs/SYNC-FLOWS.md §15).
 */
export function pushToActor(
  registry: Registry, actorId: string, workspaceId: string,
  t: string, body: Record<string, unknown>,
): number {
  let delivered = 0;
  for (const target of registry.forActors([actorId])) {
    if (target.workspaceId !== workspaceId) continue;
    target.send(t, body);
    delivered++;
  }
  return delivered;
}

export type { Delivery };
