// The event log's writer, and the closed vocabulary of what may go in it.
// Step 4 of the sync build plan (docs/SYNC-FLOWS.md §2).
//
// One writer, deliberately. Every append goes through `appendEvent` so that the
// rule the whole log depends on — an event and the effect it describes commit
// together, or neither does — is enforced by a signature rather than by
// remembering. `appendEvent` takes a `Transaction`, so there is no way to call
// it outside one.
//
// PAYLOADS ARE snake_case, and that is not an oversight. The domain layer is
// camelCase (`ops.ts` says so, and means it), but a payload is not a domain
// shape: it is the wire contract, written once and read on every catch-up and
// every live delivery. Storing it in the shape it ships in means the read path
// does no transformation at all; storing it camelCase would buy internal
// consistency and pay for it N times per event, forever.
//
// There is no CHECK constraint on `event_type`, and that is also deliberate.
// The server's writer is closed by the catalogue below, at compile time. Making
// the database close it too would turn every new event type into a migration —
// for no gain, since clients are required to tolerate types they do not know
// (an unknown event type still advances the cursor, invariant 32).
import { sql, type Transaction } from 'kysely';
import type { DB } from '../db/schema.ts';
import { ulid } from '../db/ulid.ts';

// ─── Streams ────────────────────────────────────────────────────────────────
//
// A stream is what is ORDERED. It owns a revision sequence and a client cursor.
// It is not an audience — who receives an event is computed from memberships
// when the event is sent, and is never stored on it (docs/SYNC-FLOWS.md §4).

export interface ChatStream { kind: 'chat'; id: string }
export interface SpaceStream { kind: 'space'; id: string }
export interface WorkspaceStream { kind: 'workspace'; id: string }

/**
 * Three kinds, and `actor` is not one of them.
 *
 * An actor stream is a delivery ADDRESS rather than an ordered stream:
 * everything sent to one — read state from another device, counter snapshots —
 * is a max-register or a projection. Those converge without ordering and repair
 * themselves from the next `welcome`, so none of them needs a revision, a
 * counter or a cursor. Giving it one now would be a column always equal to zero
 * and a stream kind nothing writes, which is how a constraint ends up never
 * having been exercised.
 */
export type Stream = ChatStream | SpaceStream | WorkspaceStream;

export const chatStream = (id: string): ChatStream => ({ kind: 'chat', id });
export const spaceStream = (id: string): SpaceStream => ({ kind: 'space', id });
export const workspaceStream = (id: string): WorkspaceStream =>
  ({ kind: 'workspace', id });

/**
 * Narrow a stream reference that came off the wire.
 *
 * Returns null for a kind this server does not have, which is NOT the same as
 * rejecting the connection: a newer client may name a stream kind this
 * deployment predates, and that is the ordinary state of a fleet where updates
 * are opt-in.
 *
 * It is also a real guard rather than a formality. Without it a `kind` of
 * anything at all fell through to the workspace branch of the head lookup — so
 * a client asking about `banana:spc_1` would have been answered about a
 * workspace. A cast would have compiled and done exactly that.
 */
export function parseStream(ref: { kind: string; id: string }): Stream | null {
  switch (ref.kind) {
    case 'chat': return chatStream(ref.id);
    case 'space': return spaceStream(ref.id);
    case 'workspace': return workspaceStream(ref.id);
    default: return null;
  }
}

/** `chat:cht_01M2…` — the stable name for a stream in a log line or a frame. */
export const streamName = (stream: Stream): string => `${stream.kind}:${stream.id}`;

// ─── Payloads ───────────────────────────────────────────────────────────────

/** A new message, complete enough to render without a follow-up read. */
export interface MessageCreated {
  id: string;
  ord: number;
  parent_id: string | null;
  author_id: string;
  body: string;
  created_at: string;
}

/**
 * A tombstone. The id alone, because that is all a recipient can act on: the
 * row keeps its ordinal, the body is already gone, and a client that never held
 * the message writes nothing at all — the case that forces the frontier to be
 * tracked explicitly rather than derived from message rows (DESIGN.md §8.1).
 */
export interface MessageDeleted { id: string }

export interface SpaceCreated {
  id: string;
  kind: 'channel' | 'dm' | 'group_dm' | 'room';
  name: string | null;
  slug: string | null;
  visibility: 'public' | 'private' | null;
  membership_policy: 'open' | 'invite' | 'sealed';
  lifecycle: 'active' | 'dormant' | 'archived';
}

export interface ChatCreated {
  id: string;
  space_id: string;
  kind: 'sole' | 'default' | 'public' | 'private';
  name: string | null;
}

export interface SpaceMemberAdded { actor_id: string; role: 'member' | 'admin' }
export interface SpaceMemberRemoved { actor_id: string }

/**
 * One directory row. Deactivation is an `actor.updated` carrying
 * `state: 'deactivated'` rather than a third event type: a client upserts the
 * row either way, so a separate type would carry the same information less
 * uniformly — and the actor is tombstoned rather than deleted precisely so
 * their past messages keep rendering (DESIGN.md §6.3).
 */
export interface ActorChanged {
  id: string;
  type: 'human' | 'agent';
  handle: string;
  display_name: string;
  avatar_url: string | null;
  state: 'invited' | 'active' | 'suspended' | 'deactivated';
}

// ─── The catalogue ──────────────────────────────────────────────────────────

/**
 * Every event this server may write, the stream it belongs on, and the payload
 * it carries — in one place, checked at compile time.
 *
 * Pairing the type with its stream is what makes "append a space rename to a
 * chat stream" unrepresentable rather than merely wrong.
 */
interface EventCatalogue {
  'message.created': { stream: ChatStream; payload: MessageCreated };
  'message.deleted': { stream: ChatStream; payload: MessageDeleted };

  'space.created': { stream: SpaceStream; payload: SpaceCreated };
  'space.member_added': { stream: SpaceStream; payload: SpaceMemberAdded };
  'space.member_removed': { stream: SpaceStream; payload: SpaceMemberRemoved };
  'chat.created': { stream: SpaceStream; payload: ChatCreated };

  'actor.created': { stream: WorkspaceStream; payload: ActorChanged };
  'actor.updated': { stream: WorkspaceStream; payload: ActorChanged };
}

export type EventType = keyof EventCatalogue;
type StreamOf<T extends EventType> = EventCatalogue[T]['stream'];
type PayloadOf<T extends EventType> = EventCatalogue[T]['payload'];

// ─── Allocation results, which are also where an event may be written ───────

/**
 * What one allocation produced — and, together, everything an append needs.
 *
 * The stream, its new revision and the workspace all come out of the SAME
 * `UPDATE … RETURNING`, which is what makes them impossible to mismatch. An
 * earlier sketch passed the workspace id to `appendEvent` separately; that is
 * one more argument to get wrong, and getting it wrong would file an event
 * under a tenant it does not belong to.
 */
export interface StreamAllocation {
  stream: Stream;
  rev: number;
  workspaceId: string;
}

/** A chat allocation additionally carries an ordinal — null unless a message. */
export interface ChatAllocation extends StreamAllocation {
  stream: ChatStream;
  ord: number | null;
}

/** A committed event, in the shape fanout will resolve an audience for. */
export interface AppendedEvent {
  eventId: string;
  workspaceId: string;
  stream: Stream;
  rev: number;
  type: EventType;
  payload: unknown;
}

/**
 * Write one event, in the transaction that performs the change it describes.
 *
 * The `Transaction` parameter is load-bearing, exactly as it is on `allocate`.
 * An append that commits separately from its effect is a change every client
 * applies and the database does not have — and unlike a lost ordinal, nothing
 * about it looks wrong afterwards.
 */
export async function appendEvent<T extends EventType>(
  trx: Transaction<DB>,
  allocated: StreamAllocation & { stream: StreamOf<T> },
  type: T,
  payload: PayloadOf<T>,
): Promise<AppendedEvent> {
  const eventId = ulid('evt');
  await trx.insertInto('sync_events').values({
    event_id: eventId,
    workspace_id: allocated.workspaceId,
    stream_kind: allocated.stream.kind,
    stream_id: allocated.stream.id,
    stream_rev: allocated.rev,
    event_type: type,
    // Serialised here rather than left to the driver: `payload` is jsonb, and
    // node-postgres would otherwise send a JS object as a stringified record.
    payload: sql`${JSON.stringify(payload)}::jsonb`,
  }).execute();

  return {
    eventId, workspaceId: allocated.workspaceId, stream: allocated.stream,
    rev: allocated.rev, type, payload,
  };
}
