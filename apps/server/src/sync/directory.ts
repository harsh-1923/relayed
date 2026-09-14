// The actor directory, as events on the workspace stream.
// Step 4 of the sync build plan writes them; step 10 makes clients read them
// (docs/SYNC-FLOWS.md §2).
//
// Why the directory is a stream at all, rather than an array in `welcome`:
// measured on a 1,600-member workspace it was 345 KB, 69% of the frame, and the
// ONLY term in it that grows because the company hired somebody rather than
// because this actor joined something. Chats-per-actor is bounded by what a
// person does; members-per-workspace is not bounded by anything they do
// (DESIGN.md §9.9, the `welcome` ceiling).
//
// It is the one workspace-wide stream, and it earns that only because every
// member is entitled to ALL of it — so its cursor has no holes to contain.
// Nothing else joins this stream without re-answering that question: a stream
// you are only partly allowed to read can never become contiguous, which is the
// contiguity rule (invariant 1) applied to a stream rather than to a chat.
//
// This module is the ONLY writer of directory events. Three call sites create
// or change an actor — first sign-in provisioning, accepting an invitation, and
// WorkOS deactivation — and a payload assembled independently at each of them
// is three shapes that drift.
import type { Transaction } from 'kysely';
import type { DB } from '../db/schema.ts';
import { allocateStream } from './allocate.ts';
import {
  appendEvent, workspaceStream, type ActorChanged, type AgentSummary, type AppendedEvent,
} from './events.ts';

/** One directory row, in domain shape. Mapped to the wire shape below. */
export interface DirectoryActor {
  id: string;
  workspaceId: string;
  type: 'human' | 'agent';
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /** Required for an agent, null for a person — as `actor_owner` requires. */
  ownerActorId: string | null;
  state: 'invited' | 'active' | 'suspended' | 'deactivated';
  /** An agent's summary; omitted for a person. */
  agent?: AgentSummary;
}

/**
 * Record that an actor appeared or changed.
 *
 * `actor.created` and `actor.updated` carry the identical payload and a client
 * upserts on both, so the distinction earns nothing on the receiving side. It
 * is kept because it earns something in the LOG: "when did this person join"
 * is a real question, and answering it from a stream of undifferentiated
 * updates means guessing that the earliest one was the arrival.
 *
 * Deactivation is an `actor.updated` carrying `state: 'deactivated'`, not a
 * third type. The actor is tombstoned rather than deleted precisely so their
 * past messages keep rendering (DESIGN.md §6.3), which means the row must
 * survive on every client — an event that read as a removal would invite
 * exactly the wrong handler.
 *
 * Takes a `Transaction`: the actor row and the event that announces it commit
 * together, or a workspace ends up with a member nobody else can see.
 *
 * Returns the event, for a caller that can deliver it after the commit — an
 * agent created from Settings should reach every client's autocomplete now,
 * not at their next heartbeat. A caller with nobody to deliver to may ignore it.
 */
export async function recordActor(
  trx: Transaction<DB>,
  change: 'actor.created' | 'actor.updated',
  actor: DirectoryActor,
): Promise<AppendedEvent> {
  const payload: ActorChanged = {
    id: actor.id,
    type: actor.type,
    handle: actor.handle,
    display_name: actor.displayName,
    avatar_url: actor.avatarUrl,
    owner_actor_id: actor.ownerActorId,
    state: actor.state,
    ...(actor.agent ? { agent: actor.agent } : {}),
  };
  const allocated = await allocateStream(trx, workspaceStream(actor.workspaceId));
  return appendEvent(trx, allocated, change, payload, { kind: 'stream' });
}
