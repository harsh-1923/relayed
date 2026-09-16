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
import { WITHHELD_EVENT } from '@relayed/protocol';
import { topic } from '../shared/topics.ts';
import type { Effect, Stream, Envelope } from './apply.ts';

interface ActorChanged {
  id: string; type: string; handle: string; display_name: string;
  avatar_url: string | null; state: string;
  /**
   * Absent from servers that predate agents, where it could only have been
   * null: nothing but a person reached the directory then.
   */
  owner_actor_id?: string | null;
  agent?: AgentSummary;
}

/** What every member holds about an agent. The instructions are not in it. */
export interface AgentSummary {
  description: string;
  config_rev: number;
  toolkits: { toolkit: string; effect: string }[];
}

/**
 * Store an agent's summary beside its actor row. Shared by the live event and
 * the directory page, so the two cannot write one agent differently.
 */
export function storeAgentSummary(db: DatabaseSync, actorId: string, summary: AgentSummary): void {
  db.prepare(`
    INSERT INTO agent_summaries (actor_id, description, config_rev, toolkits)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(actor_id) DO UPDATE SET
      description = excluded.description, config_rev = excluded.config_rev,
      toolkits = excluded.toolkits
  `).run(actorId, summary.description, summary.config_rev, JSON.stringify(summary.toolkits));
}

interface MessageCreated {
  id: string; ord: number; parent_id: string | null;
  author_id: string; body: string; created_at: string;
  /** Present only on a message some people cannot see — and this client is on it. */
  visible_to?: string[];
  /** Present only on a message made of parts. Stored as sent, and read leniently. */
  parts?: unknown[];
  /** Present only on an agent's reply: whose authority it spent, and the run that spent it. */
  on_behalf_of_actor_id?: string;
  delegation_id?: string;
  /** Present only for a system row (SPACE-MEMBERSHIP-MARKERS.md). Absent means 'actor'. */
  message_kind?: 'system';
  system_kind?: 'space.member_added';
  subject_actor_id?: string;
}

export interface DocumentRow {
  id: string;
  space_id: string;
  kind: string;
  title: string | null;
  body: string;
  format: string;
  rev: number;
  updated_by_actor_id: string | null;
  covered_through?: Record<string, number> | null;
  updated_at: string;
}

/**
 * One document, upserted — and NEVER wound back (DOCUMENTS.md §7.2).
 *
 * `rev` is monotonic per document, so an event that arrives late or twice must
 * not replace a newer body with an older one. The guard is in the statement
 * rather than in a read-then-write, so two applies racing cannot both win.
 */
export function storeDocument(db: DatabaseSync, row: DocumentRow): void {
  db.prepare(`
    INSERT INTO documents (id, space_id, kind, title, body, format, rev,
                           updated_by_actor_id, covered_through, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind, title = excluded.title, body = excluded.body,
      format = excluded.format, rev = excluded.rev,
      updated_by_actor_id = excluded.updated_by_actor_id,
      covered_through = excluded.covered_through,
      updated_at = excluded.updated_at
    WHERE excluded.rev > documents.rev
  `).run(row.id, row.space_id, row.kind, row.title, row.body, row.format ?? 'markdown', row.rev,
         row.updated_by_actor_id, row.covered_through ? JSON.stringify(row.covered_through) : null,
         Date.parse(row.updated_at) || Date.now());
}

interface SpaceMemberAddedHydration {
  space: {
    id: string; kind: string; name: string | null; slug: string | null;
    visibility: string | null; membership_policy: string; lifecycle: string;
    /** Absent from a server that predates them. */
    created_by_actor_id?: string | null; on_behalf_of_actor_id?: string | null;
    member_ids?: string[] | null;
    rev: number;
  };
  chats: {
    id: string; space_id: string; kind: string; name: string | null;
    head_ord: number; head_rev: number;
  }[];
  /** The room's open panels — absent from a server that predates them, and for a space with none. */
  panels?: PanelRow[];
  /** The space's documents — absent from a server that predates them, and for a space with none. */
  documents?: DocumentRow[];
}

interface SpaceMemberAdded {
  actor_id: string;
  role: string;
  by_actor_id?: string;
  /** Present on every delivery; only applied when `actor_id` is the active replica actor. */
  hydration?: SpaceMemberAddedHydration;
}

/**
 * One shared panel as the wire carries it — in `panel.opened`, in `welcome`,
 * and in a newly added member's hydration (PANELS.md).
 */
export interface PanelRow {
  id: string;
  space_id: string;
  type: string;
  payload: Record<string, unknown>;
  title: string | null;
  opened_from_chat_id: string | null;
  created_by_actor_id: string | null;
  on_behalf_of_actor_id: string | null;
  created_at: string;
  opened_at: string;
}

/**
 * Write one shared panel, replacing the row by id. Every way a panel arrives
 * goes through here, so a panel opened live, one delivered in `welcome` and one
 * that came with joining the room cannot be stored three different ways.
 */
export function storePanel(db: DatabaseSync, row: PanelRow): void {
  const millis = (value: string): number => {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  };
  db.prepare(`
    INSERT INTO panels (id, space_id, type, chat_id, payload, title, opened_from_chat_id,
                        created_by_actor_id, on_behalf_of_actor_id, created_at, opened_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type, payload = excluded.payload, title = excluded.title,
      opened_from_chat_id = excluded.opened_from_chat_id,
      created_by_actor_id = excluded.created_by_actor_id,
      on_behalf_of_actor_id = excluded.on_behalf_of_actor_id,
      opened_at = MAX(panels.opened_at, excluded.opened_at)
  `).run(row.id, row.space_id, row.type, JSON.stringify(row.payload ?? {}), row.title,
         row.opened_from_chat_id, row.created_by_actor_id, row.on_behalf_of_actor_id,
         millis(row.created_at), millis(row.opened_at));
}

/** Parts as the replica stores them: JSON, or NULL for a message that is its body. */
export const partsColumn = (parts: unknown): string | null =>
  Array.isArray(parts) && parts.length > 0 ? JSON.stringify(parts) : null;

/**
 * The replica's handlers, as one function `applyEvent` can call.
 *
 * `onUnknown` is called for a type with no entry. It is NOT an error path: a
 * client from three months ago is meeting a server that has shipped since, and
 * updates are opt-in, so that is the ordinary state of the fleet.
 *
 * `activeActorId` is read once per event, not captured — the active workspace
 * actor can change under a live link (switching workspaces), so this is a
 * getter closure, the same convention `LinkDeps.workspaceId` already uses.
 * Optional and additive: every existing call site with zero or one argument
 * keeps working, and simply never hydrates (SPACE-MEMBERSHIP-MARKERS.md).
 */
export function replicaEffect(
  onUnknown?: (type: string) => void,
  activeActorId?: () => string | null,
): Effect {
  return (db: DatabaseSync, stream: Stream, event: Envelope): string[] => {
    switch (event.type) {
      case 'message.created': return messageCreated(db, stream, event);
      case 'message.deleted': return messageDeleted(db, stream, event);
      case 'message.updated': return messageUpdated(db, stream, event);

      // The revision of something this reader may not see (WORKSPACE-AGENTS.md
      // §8.4). KNOWN, so it is not counted as unknown — and it does nothing,
      // which is the entire point: the frontier passes it and no row, badge or
      // count moves. There is nothing in its payload to act on, by design.
      case WITHHELD_EVENT:
        return [];

      // Space topology. The rows already arrive in `welcome`; these keep them
      // current between reconnects, which is the whole reason a space is a
      // stream rather than a snapshot. `space.member_added` additionally
      // hydrates the space itself when it names the active actor, so a newly
      // added member sees it without reconnecting.
      case 'space.member_added':
        return spaceMemberAdded(db, stream, event, activeActorId?.() ?? null);
      case 'space.member_removed':
      case 'space.created':
      case 'chat.created':
        return [topic.space(stream.id), topic.spaces()];

      // A room's summary, written or rewritten (DOCUMENTS.md §7.1).
      case 'document.updated': {
        storeDocument(db, event.payload as DocumentRow);
        return [topic.documents(stream.id)];
      }

      // A page opened for everyone in a room, or brought forward (PANELS.md).
      case 'panel.opened': {
        const row = event.payload as PanelRow;
        storePanel(db, { ...row, space_id: stream.id });
        return [topic.panels(stream.id)];
      }

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
  // `message_kind`/`system_kind`/`subject_actor_id` are absent from the
  // ON CONFLICT SET: kind is immutable once written (SPACE-MEMBERSHIP-MARKERS.md),
  // the same reason `id`/`chat_id`/`author_id` are absent from it too.
  db.prepare(`
    INSERT INTO messages (id, chat_id, parent_id, ord, rev, author_id, body,
                          created_at, state, local_only, visible_to, parts,
                          on_behalf_of_actor_id, delegation_id,
                          message_kind, system_kind, subject_actor_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'acked', 0, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      ord = excluded.ord, rev = excluded.rev, body = excluded.body,
      created_at = excluded.created_at, state = 'acked',
      visible_to = excluded.visible_to, parts = excluded.parts
  `).run(body.id, stream.id, body.parent_id, body.ord, event.rev,
         body.author_id, body.body, Date.parse(body.created_at),
         body.visible_to ? JSON.stringify(body.visible_to) : null, partsColumn(body.parts),
         body.on_behalf_of_actor_id ?? null, body.delegation_id ?? null,
         body.message_kind ?? 'actor', body.system_kind ?? null, body.subject_actor_id ?? null);

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

/**
 * Hydrate the space named by a `space.member_added` event, when it names the
 * active replica actor — so a newly added member sees the space, its chats,
 * and their own membership without waiting for a reconnect
 * (SPACE-MEMBERSHIP-MARKERS.md).
 *
 * Every recipient of this event carries the same `hydration` block; only the
 * client whose own actor id matches `actor_id` applies it. Everyone else — the
 * ordinary case, an existing member learning who was added — falls through to
 * the same topology-invalidation-only behaviour this event has always had.
 *
 * Mirrors `Storage.applyWelcome`'s row shapes for `spaces`/`chats`/`chat_state`/
 * `stream_state`, scoped to one space rather than a full replace. The
 * membership row is upserted for THIS actor alone, never a delete-then-reinsert
 * — a wildcard delete here would erase memberships this event knows nothing
 * about, unlike `applyWelcome`'s full replacement of the whole membership set.
 *
 * NO `BEGIN`/`COMMIT` here: `applyEvent` (`apply.ts`) already runs every
 * effect call inside its own transaction. A nested `BEGIN` throws in SQLite.
 */
function spaceMemberAdded(
  db: DatabaseSync, stream: Stream, event: Envelope, activeActorId: string | null,
): string[] {
  const body = event.payload as SpaceMemberAdded;

  if (body.actor_id !== activeActorId || !body.hydration) {
    return [topic.space(stream.id), topic.spaces()];
  }
  const { space, chats } = body.hydration;
  const now = Date.now();

  db.prepare(`
    INSERT INTO spaces (id, workspace_id, kind, name, slug, visibility,
                        membership_policy, lifecycle, created_by_actor_id, on_behalf_of_actor_id,
                        member_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind, name = excluded.name, slug = excluded.slug,
      visibility = excluded.visibility,
      membership_policy = excluded.membership_policy,
      lifecycle = excluded.lifecycle,
      created_by_actor_id = excluded.created_by_actor_id,
      on_behalf_of_actor_id = excluded.on_behalf_of_actor_id,
      member_ids = excluded.member_ids,
      updated_at = excluded.updated_at
  `).run(space.id, stream.id, space.kind, space.name, space.slug,
         space.visibility, space.membership_policy, space.lifecycle,
         space.created_by_actor_id ?? null, space.on_behalf_of_actor_id ?? null,
         space.member_ids ? JSON.stringify(space.member_ids) : null, now, now);

  const chat = db.prepare(`
    INSERT INTO chats (id, workspace_id, space_id, kind, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      space_id = excluded.space_id, kind = excluded.kind,
      name = excluded.name, updated_at = excluded.updated_at
  `);
  const chatState = db.prepare(`
    INSERT INTO chat_state (chat_id, head_ord) VALUES (?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      head_ord = MAX(chat_state.head_ord, excluded.head_ord)
  `);
  const chatCursor = db.prepare(`
    INSERT INTO stream_state (stream_kind, stream_id, server_head_rev)
    VALUES ('chat', ?, ?)
    ON CONFLICT(stream_kind, stream_id) DO UPDATE SET
      server_head_rev = MAX(stream_state.server_head_rev, excluded.server_head_rev)
  `);
  for (const c of chats) {
    chat.run(c.id, stream.id, c.space_id, c.kind, c.name, now, now);
    chatState.run(c.id, c.head_ord);
    chatCursor.run(c.id, c.head_rev);
  }
  for (const panel of body.hydration.panels ?? []) storePanel(db, { ...panel, space_id: stream.id });
  for (const document of body.hydration.documents ?? []) storeDocument(db, { ...document, space_id: stream.id });

  db.prepare(`
    INSERT INTO memberships (scope_type, scope_id, actor_id, role, joined_at, left_at)
    VALUES ('space', ?, ?, ?, ?, NULL)
    ON CONFLICT(scope_type, scope_id, actor_id) DO UPDATE SET
      role = excluded.role, left_at = NULL
  `).run(space.id, activeActorId, body.role, now);

  return [topic.space(stream.id), topic.spaces(), topic.panels(stream.id)];
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

/**
 * The server replaced a message's content — an access card changing state, say
 * (WORKSPACE-AGENTS.md §7.4). Not an edit: nothing here marks it edited.
 *
 * GUARDED BY VERSION, unlike a creation. A row fetched by repair can already
 * hold a NEWER version than this event while the event was still on its way —
 * repair reads current state, not the log — and applying the older content
 * over it would wind the card back with nothing left to correct it. Equal is
 * applied: the fetched row and the event describe the same change.
 *
 * A message not held, or a tombstone, is untouched and the revision is still
 * accounted for (§11.2): a later fetch returns the current content anyway.
 */
function messageUpdated(db: DatabaseSync, stream: Stream, event: Envelope): string[] {
  const { id, body, parts } = event.payload as { id: string; body: string; parts?: unknown[] };
  // The parts are replaced WHOLE, and an update without them clears them: the
  // event is the message's complete new content, not a patch.
  const result = db.prepare(`
    UPDATE messages SET body = ?, parts = ?, rev = ?
     WHERE id = ? AND chat_id = ? AND deleted = 0 AND COALESCE(rev, 0) <= ?
  `).run(body, partsColumn(parts), event.rev, id, stream.id, event.rev);
  return result.changes > 0 ? [topic.messages(stream.id)] : [];
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
  // THE OWNER, from the payload. This wrote NULL, which the replica's CHECK
  // refuses for an agent — so an agent created while a client was connected
  // failed to apply on that client and never reached its autocomplete. Only
  // directory pages, which carried the owner, could deliver one.
  db.prepare(`
    INSERT INTO actors (id, workspace_id, type, handle, display_name,
                        avatar_url, owner_actor_id, state, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type, handle = excluded.handle,
      display_name = excluded.display_name, avatar_url = excluded.avatar_url,
      owner_actor_id = excluded.owner_actor_id,
      state = excluded.state, updated_at = excluded.updated_at,
      avatar_blob = CASE
        WHEN actors.avatar_url IS NOT DISTINCT FROM excluded.avatar_url
        THEN actors.avatar_blob ELSE NULL END
  `).run(actor.id, stream.id, actor.type, actor.handle, actor.display_name,
         actor.avatar_url, actor.owner_actor_id ?? null, actor.state, Date.now());
  if (actor.agent) storeAgentSummary(db, actor.id, actor.agent);

  // A DEACTIVATED actor is updated, never removed. Their past messages still
  // have to render — a client that dropped the row would show an empty name
  // where a greyed one belongs (DESIGN.md §6.3).
  return [topic.actors()];
}
