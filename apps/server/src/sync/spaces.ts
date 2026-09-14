// Creating a space, and who may come and go from one.
//
// Not sync ops — nothing here allocates a revision — but the log needs somewhere
// to put messages, and Phase 2's milestone needs two actors who can both reach
// the same chat.
//
// `createChannel` rather than `createSpace(kind, …)`, deliberately. The kinds
// share a table because their STRUCTURE is uniform — a container of chats with
// a member list — and differ only in policy (DESIGN.md §7.1). The constructor
// is where that policy lives, so a single entry point would be a four-way
// branch over exactly the matrix the unified table exists to keep out of
// queries. Separate constructors are that discriminated union expressed as
// functions: `createDm(a, b)` has no slug parameter to misuse.
//
// Phase 5 adds `createRoom` and `createDm` as siblings. They share a skeleton
// with this one — a transaction inserting a space, its chat, and the founding
// membership — which is worth extracting THEN, with two callers to shape it,
// rather than now with one.
import { sql, type Kysely, type Transaction } from 'kysely';
import { can, workspace as workspaceTarget, space as spaceTarget } from '@relayed/authz';
import type { DB } from '../db/schema.ts';
import { loadGrants, Forbidden } from '../authz/can.ts';
import { spacePlacement } from './placement.ts';
import { allocateStream } from './allocate.ts';
import { appendEvent, spaceStream, type AppendedEvent } from './events.ts';
import { ulid } from '../db/ulid.ts';

export interface NewChannel {
  workspaceId: string;
  name: string;
  slug?: string | null;
  visibility?: 'public' | 'private';
  createdBy: string;
}

export interface Channel {
  spaceId: string;
  chatId: string;
  /**
   * The three events creation produced, in revision order, for the caller to
   * deliver. Returned rather than delivered here for the same reason `send`
   * returns its own: nothing in this file knows a socket exists, and fanning
   * out inside the transaction would publish a space that a rollback un-created.
   */
  events: AppendedEvent[];
}

/** No such workspace. Distinguished from "not allowed", which is Forbidden. */
export class UnknownWorkspaceError extends Error {
  readonly workspaceId: string;
  constructor(workspaceId: string) {
    super(`no workspace ${workspaceId}`);
    this.name = 'UnknownWorkspaceError';
    this.workspaceId = workspaceId;
  }
}

/** A slug already taken in this workspace. Surfaced, not swallowed. */
export class SlugTakenError extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(`slug ${slug} is already taken in this workspace`);
    this.name = 'SlugTakenError';
    this.slug = slug;
  }
}

/**
 * Create a channel: the space, its sole chat, and the creator's membership.
 *
 * One transaction, because a space without its chat is a channel with nowhere
 * to talk and a chat without a membership is a channel its own creator cannot
 * read. Neither half is useful alone, so neither half may survive alone.
 *
 * The creator joins as `admin`. That is not a courtesy — it is what stops a
 * space being stranded when its creator is deprovisioned by SCIM, because an
 * admin can promote somebody else (DESIGN.md §7.3).
 */
export async function createChannel(db: Kysely<DB>, input: NewChannel): Promise<Channel> {
  const grants = await loadGrants(db, input.createdBy);
  // Through can(), never a role comparison here. Membership alone suffices for
  // this action today; if that ever needs a role, it changes in one file.
  if (!can(grants, 'create_space', workspaceTarget(input.workspaceId))) {
    throw new Forbidden('create_space', workspaceTarget(input.workspaceId));
  }

  // DERIVED, never passed. `spaces` carries org_id and workspace_id as separate
  // foreign keys and nothing ties them together, so a caller supplying both can
  // create a space whose organisation disagrees with its workspace's — verified
  // insertable before this changed. Deriving it removes the failure mode rather
  // than guarding against it.
  const workspace = await db.selectFrom('workspaces').select('org_id')
    .where('id', '=', input.workspaceId).executeTakeFirst();
  if (!workspace) throw new UnknownWorkspaceError(input.workspaceId);

  const spaceId = ulid('spc');
  const chatId = ulid('cht');
  const visibility = input.visibility ?? 'public';

  const membershipPolicy = visibility === 'public' ? 'open' : 'invite';
  const events: AppendedEvent[] = [];

  try {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('spaces').values({
        id: spaceId, org_id: workspace.org_id, workspace_id: input.workspaceId,
        kind: 'channel', name: input.name, slug: input.slug ?? null, topic: null,
        visibility,
        // Public means discoverable and joinable, NOT auto-joined — membership
        // stays explicit either way (DESIGN.md §7.2).
        membership_policy: membershipPolicy,
        created_by_actor_id: input.createdBy,
      }).execute();

      await trx.insertInto('chats').values({
        id: chatId, workspace_id: input.workspaceId, space_id: spaceId,
        kind: 'sole', name: null, created_by_actor_id: input.createdBy,
      }).execute();

      await trx.insertInto('memberships').values({
        scope_type: 'space', scope_id: spaceId, actor_id: input.createdBy,
        role: 'admin',
      }).execute();

      // THREE events, not one composite, and the extra revisions are the point.
      // `chat.created` and `space.member_added` have to exist anyway — the
      // first for rooms, the second for every join — so a client that handles
      // them handles creation with no additional code. One composite event
      // would buy two revisions and cost a special case on every recipient,
      // which is the trade the ack/event symmetry already refuses elsewhere.
      //
      // The audience is the founder alone: an event on `space:<id>` goes to
      // that space's members, and right now that is one person. Everyone else
      // learns of a public space by browsing the directory, and of a space they
      // join through the ordinary gap path (DESIGN.md §7.2).
      events.push(await appendEvent(trx, await allocateStream(trx, spaceStream(spaceId)),
        'space.created', {
          id: spaceId, kind: 'channel', name: input.name,
          slug: input.slug ?? null, visibility,
          membership_policy: membershipPolicy, lifecycle: 'active',
        }, { kind: 'stream' }));

      events.push(await appendEvent(trx, await allocateStream(trx, spaceStream(spaceId)),
        'chat.created',
        { id: chatId, space_id: spaceId, kind: 'sole', name: null }, { kind: 'stream' }));

      events.push(await appendEvent(trx, await allocateStream(trx, spaceStream(spaceId)),
        'space.member_added', { actor_id: input.createdBy, role: 'admin' }, { kind: 'stream' }));
    });
  } catch (err) {
    if (isConstraint(err, 'space_slug')) throw new SlugTakenError(input.slug ?? '');
    throw err;
  }

  return { spaceId, chatId, events };
}

/**
 * Join a space yourself.
 *
 * Permitted only where the space's policy is `open` — a public channel or a
 * public room. Public means discoverable and JOINABLE, not auto-joined, so this
 * is the act that turns discovery into membership (DESIGN.md §7.2).
 *
 * `join` is the one space action that cannot require space membership, because
 * membership is what it creates. The workspace conjunct above it still holds:
 * you cannot walk into a space in a workspace you do not belong to.
 */
export async function joinSpace(
  db: Kysely<DB>, spaceId: string, actorId: string,
): Promise<AppendedEvent> {
  await requireSpace(db, actorId, spaceId, 'join');
  return db.transaction().execute(trx => addMember(trx, spaceId, actorId, 'member'));
}

/**
 * Add somebody else to a space.
 *
 * Any member may, deliberately: adding one person and exposing the whole space
 * to the workspace have very different blast radii, which is why this is open
 * and `make_public` is admin-only (DESIGN.md §7.3).
 */
export async function addToSpace(
  db: Kysely<DB>, spaceId: string, actorId: string, by: string,
  role: 'member' | 'admin' = 'member',
): Promise<AppendedEvent> {
  await requireSpace(db, by, spaceId, 'add_member');
  return db.transaction().execute(trx => addMember(trx, spaceId, actorId, role));
}

/**
 * Leave a space.
 *
 * Always permitted and never checked. Nobody needs permission to stop
 * participating, and a rule that could refuse would be a rule that traps
 * someone in a conversation.
 */
export async function leaveSpace(
  db: Kysely<DB>, spaceId: string, actorId: string,
): Promise<AppendedEvent> {
  return db.transaction().execute(trx => removeMember(trx, spaceId, actorId));
}

/**
 * Remove somebody else from a space. Space admins only.
 *
 * The asymmetry with `addToSpace` is deliberate and matches `make_public`:
 * adding a person is reversible by the person, and removing one is not
 * something any member should be able to do to any other.
 *
 * Removing yourself is leaving, needs no permission, and is routed there rather
 * than refused — a caller passing the same actor twice means the ordinary thing.
 */
export async function removeFromSpace(
  db: Kysely<DB>, spaceId: string, actorId: string, by: string,
): Promise<AppendedEvent> {
  if (by !== actorId) await requireSpace(db, by, spaceId, 'remove_member');
  return db.transaction().execute(trx => removeMember(trx, spaceId, actorId));
}

/** Members of a space who have not left. The fanout set for every chat in it. */
export async function spaceMembers(db: Kysely<DB>, spaceId: string): Promise<string[]> {
  return membersOf(db, 'space', spaceId);
}

/**
 * Members of a private chat who have not left.
 *
 * Only ever the SECOND conjunct of the access predicate — space membership
 * leads, and this narrows it (invariant 50). Used alone it would grant an actor
 * removed from a space continued access to a private chat inside it, through a
 * chat membership row nobody thought to tombstone.
 *
 * Private chats arrive in Phase 5, so nothing writes these rows yet. The read
 * exists now because the audience calculation is where getting the predicate
 * backwards would be an access leak rather than a missing feature — and a
 * branch with no test is a branch that is wrong when it finally runs.
 */
export async function chatMembers(db: Kysely<DB>, chatId: string): Promise<string[]> {
  return membersOf(db, 'chat', chatId);
}

/**
 * Everyone in a workspace who has not left.
 *
 * The audience for the one workspace-wide stream, the actor directory — and it
 * is the right answer there ONLY because every member is entitled to all of it,
 * so no recipient ends up with a cursor full of holes (DESIGN.md §9.9).
 */
export async function workspaceMembers(
  db: Kysely<DB>, workspaceId: string,
): Promise<string[]> {
  return membersOf(db, 'workspace', workspaceId);
}

/**
 * One shape for all three, because they are one question asked of one table.
 *
 * A permission is a row (AUTHZ.md §4), so "who belongs to this" is the same
 * query whatever `this` is — and three hand-written copies would be three
 * chances to forget `left_at IS NULL`, which is the clause that makes removal
 * take effect.
 */
async function membersOf(
  db: Kysely<DB>, scopeType: 'workspace' | 'space' | 'chat', scopeId: string,
): Promise<string[]> {
  const rows = await db.selectFrom('memberships').select('actor_id')
    .where('scope_type', '=', scopeType)
    .where('scope_id', '=', scopeId)
    .where('left_at', 'is', null)
    .execute();
  return rows.map(row => row.actor_id);
}

/**
 * Write the membership row, and record that it changed.
 *
 * Idempotent, and re-joining CLEARS `left_at` rather than inserting a second
 * row. That is what makes re-adding a removed member the gap case rather than a
 * special case: the membership resumes, the cursor is behind, and the existing
 * backfill machinery heals it (DESIGN.md §6.6).
 *
 * Takes a `Transaction` because the row and its event must commit together.
 * Membership is the one piece of state that decides who receives everything
 * else, so a membership that landed without its event would leave every other
 * member's copy of the member list permanently wrong, with nothing to repair it
 * short of a full resync.
 */
export async function addMember(
  trx: Transaction<DB>, spaceId: string, actorId: string, role: 'member' | 'admin',
): Promise<AppendedEvent> {
  await trx.insertInto('memberships')
    .values({ scope_type: 'space', scope_id: spaceId, actor_id: actorId, role })
    .onConflict(oc => oc.columns(['scope_type', 'scope_id', 'actor_id'])
      .doUpdateSet({ left_at: null, joined_at: sql`now()` }))
    .execute();

  return appendEvent(trx, await allocateStream(trx, spaceStream(spaceId)),
    'space.member_added', { actor_id: actorId, role }, { kind: 'stream' });
}

/**
 * A tombstone, never a delete. "Was Alice ever in this space" stays answerable,
 * and the local copy on her device freezes rather than being recalled — removal
 * stops new data, it is not a retroactive recall (DESIGN.md §6.6).
 *
 * The event is appended whether or not the UPDATE matched a row, which is the
 * same call `deleteMessage` makes for an already-deleted message: the event is
 * idempotent where it lands, so short-circuiting would buy a branch and a
 * second round trip to discover something no recipient can tell apart.
 */
async function removeMember(
  trx: Transaction<DB>, spaceId: string, actorId: string,
): Promise<AppendedEvent> {
  await trx.updateTable('memberships')
    .set({ left_at: sql`now()` })
    .where('scope_type', '=', 'space')
    .where('scope_id', '=', spaceId)
    .where('actor_id', '=', actorId)
    .where('left_at', 'is', null)
    .execute();

  // Worth knowing about this event: the actor it names does NOT receive it.
  // Fanout resolves an audience from committed membership state, and by then
  // they are not a member — which is the whole point of computing the audience
  // per event instead of holding a subscription (docs/SYNC-FLOWS.md §7). They
  // learn of it the next time they reconnect and the space is absent from
  // `welcome`; until then their local copy simply freezes.
  return appendEvent(trx, await allocateStream(trx, spaceStream(spaceId)),
    'space.member_removed', { actor_id: actorId }, { kind: 'stream' });
}

/** Load grants and placement once, then ask can() a single question. */
async function requireSpace(
  db: Kysely<DB>, actorId: string, spaceId: string, action: string,
): Promise<void> {
  const [grants, placement] = await Promise.all([
    loadGrants(db, actorId), spacePlacement(db, spaceId),
  ]);
  if (!can(grants, action, spaceTarget(spaceId), placement)) {
    throw new Forbidden(action, spaceTarget(spaceId));
  }
}

const isConstraint = (err: unknown, name: string): boolean =>
  typeof err === 'object' && err !== null
  && (err as { constraint?: string }).constraint === name;
