// What each event type does to the replica, and which surfaces it wakes.
// Step 8 of the sync build plan (docs/SYNC-FLOWS.md §2).
//
// Split from the frontier logic deliberately. `apply.ts` decides WHETHER an
// event is applied — the three-case rule that must never be wrong — and this
// decides WHAT applying it means. Keeping them apart means a new event type is
// one entry here and touches nothing that could stall a cursor.
//
// EVERY HANDLER MAY LEGITIMATELY DO NOTHING. A delete for a message never
// backfilled, an edit below the eviction floor, an event type this build has
// never heard of: all three are normal, and all three still account for their
// revision. That is invariant 32, and it is why an empty topic list is a
// success rather than a failure (docs/SYNC-FLOWS.md §11.2).
import type { DatabaseSync } from 'node:sqlite';
import { topic } from '../shared/topics.ts';
import type { Effect, Stream, Envelope } from './apply.ts';

interface ActorChanged {
  id: string; type: string; handle: string; display_name: string;
  avatar_url: string | null; state: string;
}

interface MessageCreated {
  id: string; ord: number; parent_id: string | null;
  author_id: string; body: string; created_at: string;
}

/**
 * The replica's handlers, as one function `applyEvent` can call.
 *
 * `onUnknown` is called for a type with no entry. It is NOT an error path: a
 * client from three months ago is meeting a server that has shipped since, and
 * updates are opt-in, so that is the ordinary state of the fleet.
 */
export function replicaEffect(onUnknown?: (type: string) => void): Effect {
  return (db: DatabaseSync, stream: Stream, event: Envelope): string[] => {
    switch (event.type) {
      case 'message.created': return messageCreated(db, stream, event);
      case 'message.deleted': return messageDeleted(db, stream, event);

      // Space topology. The rows already arrive in `welcome`; these keep them
      // current between reconnects, which is the whole reason a space is a
      // stream rather than a snapshot.
      case 'space.member_added':
      case 'space.member_removed':
      case 'space.created':
      case 'chat.created':
        return [topic.space(stream.id), topic.spaces()];

      // The directory, on the one workspace-wide stream. Steady state is one
      // event and one row — not a re-send of 1,600 of them, which is the entire
      // reason it is a stream rather than an array in `welcome`.
      case 'actor.created':
      case 'actor.updated':
        return actorChanged(db, stream, event);

      default:
        onUnknown?.(event.type);
        return [];
    }
  };
}

function messageCreated(db: DatabaseSync, stream: Stream, event: Envelope): string[] {
  const body = event.payload as MessageCreated;

  // UPSERT, not insert. The sender receives its own message twice — once as the
  // ack that stamps its optimistic row, once as this event travelling the same
  // path as on every other device. One convergence mechanism rather than a
  // special case for "mine" is worth the conflict clause.
  db.prepare(`
    INSERT INTO messages (id, chat_id, parent_id, ord, rev, author_id, body,
                          created_at, state, local_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'acked', 0)
    ON CONFLICT(id) DO UPDATE SET
      ord = excluded.ord, rev = excluded.rev, body = excluded.body,
      created_at = excluded.created_at, state = 'acked'
  `).run(body.id, stream.id, body.parent_id, body.ord, event.rev,
         body.author_id, body.body, Date.parse(body.created_at));

  // `head_ord` is a MAX for the same reason `last_read_ord` is: events can
  // arrive after a `welcome` that already reported a higher head, and walking
  // it backwards would make the chat look shorter than it is.
  db.prepare(`
    INSERT INTO chat_state (chat_id, head_ord) VALUES (?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      head_ord = MAX(chat_state.head_ord, excluded.head_ord)
  `).run(stream.id, body.ord);

  // A reply moves its parent's count, and its parent's VERSION — the mirror of
  // the server's rule that a reply touches its parent (events.ts, the version
  // rule). The version matters as much as the count: a repair page computed
  // before this reply landed carries the parent at an older version, and it is
  // the bumped local version that stops that page winding the count back.
  if (body.parent_id) {
    db.prepare(`
      UPDATE messages SET reply_count = reply_count + 1, rev = ?
       WHERE id = ? AND chat_id = ?
    `).run(event.rev, body.parent_id, stream.id);
  }

  return [topic.messages(stream.id), topic.chatState(stream.id)];
}

function messageDeleted(db: DatabaseSync, stream: Stream, event: Envelope): string[] {
  const { id, parent_id: parentId } = event.payload as { id: string; parent_id?: string | null };

  // A TOMBSTONE, and the row keeps its ordinal. The gap it leaves in the
  // sequence is normal and permanent — `ord` is never renumbered or reused, or
  // read cursors and scroll positions corrupt on every client that saw the
  // original (invariant 2).
  //
  // Read before the write, because the write below erases the one fact the
  // parent's count depends on: whether this reply was still counted here.
  const held = db.prepare('SELECT deleted FROM messages WHERE id = ? AND chat_id = ?')
    .get(id, stream.id) as { deleted: number } | undefined;
  const result = db.prepare(
    "UPDATE messages SET deleted = 1, body = '', rev = ? WHERE id = ? AND chat_id = ?",
  ).run(event.rev, id, stream.id);

  // The parent's count moves ONCE, whether or not the reply itself is held: a
  // client can hold the parent without the reply, having learned the count from
  // a row fetched after a gap. It does not move for a reply already marked
  // deleted here — that delete was counted when it was applied.
  let parentTouched = false;
  if (parentId && (!held || held.deleted === 0)) {
    parentTouched = db.prepare(`
      UPDATE messages SET reply_count = MAX(reply_count - 1, 0), rev = ?
       WHERE id = ? AND chat_id = ?
    `).run(event.rev, parentId, stream.id).changes > 0;
  }

  // NO ROW IS THE INTERESTING CASE, not the error case. A delete for a message
  // this client never held — never backfilled, or evicted under retention —
  // writes nothing at all. Its revision still has to be accounted for, and a
  // client that treated "nothing to update" as a failure would stall its own
  // frontier permanently while looking perfectly healthy. This is the exact
  // case that forced the frontier to be tracked explicitly.
  if (result.changes === 0 && !parentTouched) return [];

  return [topic.messages(stream.id), topic.chatState(stream.id)];
}

function actorChanged(db: DatabaseSync, stream: Stream, event: Envelope): string[] {
  const actor = event.payload as ActorChanged;

  // The workspace comes from the STREAM, which for a directory event IS the
  // workspace — no lookup, and no chance of filing an actor under the wrong one.
  //
  // Upsert, and `avatar_blob` is preserved while the URL is unchanged. The
  // bytes we hold are the OLD url's, so keeping the pointer across a change
  // would render yesterday's picture; dropping it on every update would make
  // prefetching pointless. Same rule the HTTP directory used, for the same
  // reason.
  db.prepare(`
    INSERT INTO actors (id, workspace_id, type, handle, display_name,
                        avatar_url, owner_actor_id, state, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type, handle = excluded.handle,
      display_name = excluded.display_name, avatar_url = excluded.avatar_url,
      state = excluded.state, updated_at = excluded.updated_at,
      avatar_blob = CASE
        WHEN actors.avatar_url IS NOT DISTINCT FROM excluded.avatar_url
        THEN actors.avatar_blob ELSE NULL END
  `).run(actor.id, stream.id, actor.type, actor.handle, actor.display_name,
         actor.avatar_url, actor.state, Date.now());

  // A DEACTIVATED actor is updated, never removed. Their past messages still
  // have to render — a client that dropped the row would show an empty name
  // where a greyed one belongs (DESIGN.md §6.3).
  return [topic.actors()];
}
