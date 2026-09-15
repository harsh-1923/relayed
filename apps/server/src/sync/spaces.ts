// Creating a space, and who may come and go from one.
//
// Constructors commit topology and its ordered events together.
//
// `createChannel` rather than `createSpace(kind, …)`, deliberately. The kinds
// share a table because their STRUCTURE is uniform — a container of chats with
// a member list — and differ only in policy (DESIGN.md §7.1). The constructor
// is where that policy lives, so a single entry point would be a four-way
// branch over exactly the matrix the unified table exists to keep out of
// queries. Separate constructors are that discriminated union expressed as
// functions: `createDm(a, b)` has no slug parameter to misuse.
//
// Channel and room constructors share the atomic skeleton below while keeping
// their structural chat and slug policy at the named entry points.
import { sql, type Kysely, type Transaction } from 'kysely';
import { can, workspace as workspaceTarget, space as spaceTarget } from '@relayed/authz';
import type { DB } from '../db/schema.ts';
import { loadGrants, Forbidden } from '../authz/can.ts';
import { spacePlacement } from './placement.ts';
import { allocateStream } from './allocate.ts';
import {
  appendEvent, spaceStream, type AppendedEvent, type SpaceMemberAdded,
} from './events.ts';
import { writeMessage } from './ops.ts';
import { ulid } from '../db/ulid.ts';
import { roomPanels } from './panels.ts';

export interface NewChannel {
  workspaceId: string;
  name: string;
  slug?: string | null;
  visibility?: 'public' | 'private';
  /** The actor performing the creation: a person, or an agent a person asked. */
  createdBy: string;
  /**
   * The person an agent is creating this for. Their `create_space` permission
   * is the one checked, they are recorded against the space, and they join it
   * as an admin beside the agent — so the room stays theirs to manage if the
   * agent is later deactivated. Absent when a person creates it themselves.
   */
  onBehalfOf?: string;
}

/** The most people in a group DM, the opener included. */
export const DM_MAX_MEMBERS = 9;

/** A DM's founding participants: the opener and whoever they chose, once each, sorted. */
export const dmKey = (actorIds: readonly string[]): string => [...new Set(actorIds)].sort().join(',');

/** Who a DM or group DM was opened between, from its key; null for every other kind. */
export const dmMembers = (dmKey: string | null): string[] | null => (dmKey ? dmKey.split(',') : null);

/** A DM was asked for with nobody else in it, or with more people than a group DM holds. */
export class InvalidDmMembersError extends Error {
  readonly reason: 'nobody' | 'too_many';
  constructor(reason: 'nobody' | 'too_many') {
    super(reason === 'nobody' ? 'a conversation needs someone else in it' : `a group DM holds at most ${DM_MAX_MEMBERS} people`);
    this.name = 'InvalidDmMembersError';
    this.reason = reason;
  }
}

export interface OpenedDm extends CreatedSpace {
  /** False when the conversation already existed and was only opened. */
  created: boolean;
}

/** The longest name a space may have. */
const SPACE_NAME_MAX = 100;

/**
 * A space name as given, trimmed — or null when it cannot be one. The single
 * rule, shared by the create route and an agent's `create_room`, so the two
 * cannot accept different names.
 */
export function spaceNameFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= SPACE_NAME_MAX ? name : null;
}

export interface CreatedSpace {
  spaceId: string;
  chatId: string;
  /**
   * The events creation produced, in revision order, for the caller to
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

/** The requested actor cannot hold a membership in this space. */
export class SpaceMemberUnavailableError extends Error {
  readonly actorId: string;
  constructor(actorId: string) {
    super(`actor ${actorId} is not an active member of this workspace`);
    this.name = 'SpaceMemberUnavailableError';
    this.actorId = actorId;
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
export async function createChannel(db: Kysely<DB>, input: NewChannel): Promise<CreatedSpace> {
  return createNamedSpace(db, input, 'channel', 'sole');
}

/** Rooms have a structural default chat and never carry a channel slug. */
export async function createRoom(db: Kysely<DB>, input: Omit<NewChannel, 'slug'>): Promise<CreatedSpace> {
  return createNamedSpace(db, { ...input, slug: null }, 'room', 'default');
}

async function createNamedSpace(
  db: Kysely<DB>, input: NewChannel, kind: 'channel' | 'room', chatKind: 'sole' | 'default',
): Promise<CreatedSpace> {
  // The authority spent is the requester's: an agent creating a room for Alice
  // may because Alice may. Through can(), never a role comparison here.
  // Membership alone suffices for this action today; if that ever needs a
  // role, it changes in one file.
  const grants = await loadGrants(db, input.onBehalfOf ?? input.createdBy);
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
        kind, name: input.name, slug: input.slug ?? null, topic: null,
        visibility,
        // Public means discoverable and joinable, NOT auto-joined — membership
        // stays explicit either way (DESIGN.md §7.2).
        membership_policy: membershipPolicy,
        created_by_actor_id: input.createdBy,
        on_behalf_of_actor_id: input.onBehalfOf ?? null,
      }).execute();

      await trx.insertInto('chats').values({
        id: chatId, workspace_id: input.workspaceId, space_id: spaceId,
        kind: chatKind, name: null, created_by_actor_id: input.createdBy,
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
          id: spaceId, kind, name: input.name,
          slug: input.slug ?? null, visibility,
          membership_policy: membershipPolicy, lifecycle: 'active',
          created_by_actor_id: input.createdBy, on_behalf_of_actor_id: input.onBehalfOf ?? null,
          member_ids: null,
        }, { kind: 'stream' }));

      events.push(await appendEvent(trx, await allocateStream(trx, spaceStream(spaceId)),
        'chat.created',
        { id: chatId, space_id: spaceId, kind: chatKind, name: null }, { kind: 'stream' }));

      const founding = await allocateStream(trx, spaceStream(spaceId));
      events.push(await appendEvent(trx, founding, 'space.member_added', {
        actor_id: input.createdBy, role: 'admin', by_actor_id: input.createdBy,
        hydration: await hydrationSnapshot(trx, spaceId, founding.rev),
      }, { kind: 'stream' }));

      // The person it was made for joins the way anyone added to a room does —
      // the same membership event and the same marker in the chat ("Alice was
      // added by Triage") — so their devices learn of it on the ordinary add
      // path, with nothing special to receive.
      if (input.onBehalfOf && input.onBehalfOf !== input.createdBy) {
        const added = await addMemberWithMarker(trx, spaceId, input.onBehalfOf, 'admin', input.createdBy, ulid('msg'));
        if (added.status === 'added') events.push(added.membershipEvent, added.messageEvent);
      }
    });
  } catch (err) {
    if (isConstraint(err, 'space_slug')) throw new SlugTakenError(input.slug ?? '');
    throw err;
  }

  return { spaceId, chatId, events };
}

/**
 * Open the DM or group DM between the opener and these people: the one that
 * already exists, or a new one (DESIGN.md §7.1).
 *
 * One other person is a `dm`; two to eight are a `group_dm`. A conversation is
 * identified by its founding participants (`spaces.dm_key`), so asking again
 * for the same people — in any order, by any of them — opens the same one.
 * Opening one you have left brings you back into it; nobody else who left is
 * brought back by your opening it.
 *
 * Everyone joins as `member`: a DM has no admin, and nobody is added to one
 * later (`sealed`). Each participant gets their own `space.member_added` with
 * the hydration, so every one of their devices learns of it the way it learns
 * of any space it is put in. No marker: nobody was "added by" anyone.
 */
export async function openDm(
  db: Kysely<DB>, input: { workspaceId: string; openedBy: string; withActorIds: readonly string[] },
): Promise<OpenedDm> {
  const participants = [...new Set([input.openedBy, ...input.withActorIds])];
  if (participants.length < 2) throw new InvalidDmMembersError('nobody');
  if (participants.length > DM_MAX_MEMBERS) throw new InvalidDmMembersError('too_many');

  const grants = await loadGrants(db, input.openedBy);
  if (!can(grants, 'create_space', workspaceTarget(input.workspaceId))) {
    throw new Forbidden('create_space', workspaceTarget(input.workspaceId));
  }
  const workspace = await db.selectFrom('workspaces').select('org_id')
    .where('id', '=', input.workspaceId).executeTakeFirst();
  if (!workspace) throw new UnknownWorkspaceError(input.workspaceId);

  // Everyone in it must be someone this workspace can reach today.
  const reachable = new Set((await db.selectFrom('actors')
    .innerJoin('memberships', join => join
      .on('memberships.scope_type', '=', 'workspace')
      .on('memberships.scope_id', '=', input.workspaceId)
      .onRef('memberships.actor_id', '=', 'actors.id')
      .on('memberships.left_at', 'is', null))
    .select('actors.id')
    .where('actors.id', 'in', participants)
    .where('actors.state', '=', 'active')
    .execute()).map(row => row.id));
  const unreachable = participants.find(id => !reachable.has(id));
  if (unreachable) throw new SpaceMemberUnavailableError(unreachable);

  const key = dmKey(participants);
  const existing = await findDm(db, input.workspaceId, key);
  if (existing) return reopenDm(db, existing, input.openedBy);

  const kind = participants.length === 2 ? 'dm' : 'group_dm';
  const spaceId = ulid('spc');
  const chatId = ulid('cht');
  const events: AppendedEvent[] = [];
  try {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('spaces').values({
        id: spaceId, org_id: workspace.org_id, workspace_id: input.workspaceId,
        kind, name: null, slug: null, topic: null, visibility: null,
        membership_policy: 'sealed', created_by_actor_id: input.openedBy, dm_key: key,
      }).execute();
      await trx.insertInto('chats').values({
        id: chatId, workspace_id: input.workspaceId, space_id: spaceId,
        kind: 'sole', name: null, created_by_actor_id: input.openedBy,
      }).execute();
      await trx.insertInto('memberships')
        .values(participants.map(actorId => ({ scope_type: 'space', scope_id: spaceId, actor_id: actorId, role: 'member' as const })))
        .execute();

      events.push(await appendEvent(trx, await allocateStream(trx, spaceStream(spaceId)), 'space.created', {
        id: spaceId, kind, name: null, slug: null, visibility: null,
        membership_policy: 'sealed', lifecycle: 'active',
        created_by_actor_id: input.openedBy, on_behalf_of_actor_id: null, member_ids: dmMembers(key),
      }, { kind: 'stream' }));
      events.push(await appendEvent(trx, await allocateStream(trx, spaceStream(spaceId)), 'chat.created',
        { id: chatId, space_id: spaceId, kind: 'sole', name: null }, { kind: 'stream' }));
      // The opener first, so their own device has the conversation before anyone else's.
      for (const actorId of [input.openedBy, ...participants.filter(id => id !== input.openedBy)]) {
        const allocated = await allocateStream(trx, spaceStream(spaceId));
        events.push(await appendEvent(trx, allocated, 'space.member_added', {
          actor_id: actorId, role: 'member', by_actor_id: input.openedBy,
          hydration: await hydrationSnapshot(trx, spaceId, allocated.rev),
        }, { kind: 'stream' }));
      }
    });
  } catch (err) {
    // Somebody opened the same conversation a moment ago: open theirs.
    if (isConstraint(err, 'space_dm_members')) {
      const raced = await findDm(db, input.workspaceId, key);
      if (raced) return reopenDm(db, raced, input.openedBy);
    }
    throw err;
  }
  return { spaceId, chatId, events, created: true };
}

async function findDm(db: Kysely<DB>, workspaceId: string, key: string): Promise<{ spaceId: string; chatId: string } | null> {
  const row = await db.selectFrom('spaces')
    .innerJoin('chats', join => join.onRef('chats.space_id', '=', 'spaces.id').on('chats.kind', '=', 'sole'))
    .select(['spaces.id as spaceId', 'chats.id as chatId'])
    .where('spaces.workspace_id', '=', workspaceId).where('spaces.dm_key', '=', key)
    .executeTakeFirst();
  return row ?? null;
}

/** An existing conversation, opened: the opener comes back into it if they had left, and nothing else changes. */
async function reopenDm(
  db: Kysely<DB>, dm: { spaceId: string; chatId: string }, openedBy: string,
): Promise<OpenedDm> {
  const rejoined = await db.transaction().execute(trx => addMember(trx, dm.spaceId, openedBy, 'member', openedBy));
  return { ...dm, events: rejoined.status === 'added' ? [rejoined.event] : [], created: false };
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
): Promise<MembershipResult> {
  await requireSpace(db, actorId, spaceId, 'join');
  return db.transaction().execute(trx => addMember(trx, spaceId, actorId, 'member', actorId));
}

/**
 * Add somebody else to a space: the membership, the space event, and the
 * chat marker that says so — all three or none (SPACE-MEMBERSHIP-MARKERS.md).
 *
 * Any member may, deliberately: adding one person and exposing the whole space
 * to the workspace have very different blast radii, which is why this is open
 * and `make_public` is admin-only (DESIGN.md §7.3).
 *
 * The marker message id is supplied by the caller (a client-generated id,
 * threaded through from the route) rather than minted here, preserving the
 * client-generated-message-id invariant even though the content is generated
 * by the system.
 */
export async function addToSpace(
  db: Kysely<DB>, spaceId: string, actorId: string, by: string, messageId: string,
): Promise<AddToSpaceResult> {
  await requireSpace(db, by, spaceId, 'add_member');
  await requireAddableSpace(db, spaceId);
  await requireAddableActor(db, spaceId, actorId);

  return db.transaction().execute(
    trx => addMemberWithMarker(trx, spaceId, actorId, 'member', by, messageId));
}

/**
 * The atomic write itself: membership, the space event, and the chat marker —
 * all three or none, inside a transaction the CALLER owns.
 *
 * Exported (rather than folded into `addToSpace`) so a caller that already has
 * its own transaction can join it, instead of nesting a second one. Agent
 * creation is that caller: `createAgent` (`agents/definitions.ts`) adds the new
 * agent to its chosen spaces inside the same transaction that creates the
 * agent's actor row, and the doc's product rule treats an agent add as a peer
 * of a person's — the same wording, the same marker (SPACE-MEMBERSHIP-MARKERS.md).
 * `addToSpace` itself is a thin wrapper: permission checks, then one owned
 * transaction around this.
 */
export async function addMemberWithMarker(
  trx: Transaction<DB>, spaceId: string, actorId: string, role: 'member' | 'admin',
  by: string, messageId: string,
): Promise<AddToSpaceResult> {
  const membership = await addMember(trx, spaceId, actorId, role, by);
  if (membership.status === 'already_member') return membership;

  const chatId = await structuralChatOf(trx, spaceId);
  const body = await markerBody(trx, by, actorId);
  const written = await writeMessage(trx, {
    kind: 'system', chatId, messageId, authorId: by,
    systemKind: 'space.member_added', subjectActorId: actorId,
    audience: { kind: 'stream' }, body,
  });

  return { status: 'added', membershipEvent: membership.event, messageEvent: written.event };
}

export type AddToSpaceResult =
  | { status: 'already_member' }
  | { status: 'added'; membershipEvent: AppendedEvent; messageEvent: AppendedEvent };

/** The space named is `sealed` — DMs and group DMs; adding a participant makes a new conversation instead. */
export class SealedSpaceError extends Error {
  readonly spaceId: string;
  constructor(spaceId: string) {
    super(`space ${spaceId} is sealed`);
    this.name = 'SealedSpaceError';
    this.spaceId = spaceId;
  }
}

/**
 * Refuse a `sealed` space before anything else runs. Enforced here, in the
 * authoritative domain operation, rather than in the shared `can()` evaluator
 * — sealed only ever gates this one action on this one object, unlike
 * `openSpaces`, which every scope-level caller needs (`placement.ts`).
 */
async function requireAddableSpace(db: Kysely<DB>, spaceId: string): Promise<void> {
  const space = await db.selectFrom('spaces').select('membership_policy')
    .where('id', '=', spaceId).executeTakeFirst();
  if (space?.membership_policy === 'sealed') throw new SealedSpaceError(spaceId);
}

/** The space's structural chat: `sole` for a channel, `default` for a room. */
async function structuralChatOf(trx: Transaction<DB>, spaceId: string): Promise<string> {
  const chat = await trx.selectFrom('chats').select('id')
    .where('space_id', '=', spaceId).where('kind', 'in', ['sole', 'default'])
    .executeTakeFirstOrThrow();
  return chat.id;
}

/** The compatibility rendering, captured at write time (SPACE-MEMBERSHIP-MARKERS.md). */
async function markerBody(
  trx: Transaction<DB>, byActorId: string, subjectActorId: string,
): Promise<string> {
  const rows = await trx.selectFrom('actors').select(['id', 'display_name'])
    .where('id', 'in', [byActorId, subjectActorId]).execute();
  const nameOf = (id: string) => rows.find(row => row.id === id)?.display_name ?? 'someone';
  return `${nameOf(subjectActorId)} was added by ${nameOf(byActorId)}`;
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

export type MembershipResult =
  | { status: 'already_member' }
  | { status: 'added'; event: AppendedEvent };

/**
 * Write the membership row, and record that it changed.
 *
 * IDEMPOTENT: an actor already active in the space returns `already_member`
 * without touching the row, allocating a revision, or appending an event
 * (SPACE-MEMBERSHIP-MARKERS.md — a repeated add must not claim, twice, that
 * somebody was added). Re-joining after having left CLEARS `left_at` rather
 * than inserting a second row, which is what makes re-adding a removed member
 * the gap case rather than a special case: the membership resumes, the cursor
 * is behind, and the existing backfill machinery heals it (DESIGN.md §6.6).
 *
 * The read is LOCKED (`forUpdate`), not merely read, so two concurrent adds of
 * the same actor cannot both observe "not active yet" and both write a marker.
 *
 * Takes a `Transaction` because the row and its event must commit together.
 * Membership is the one piece of state that decides who receives everything
 * else, so a membership that landed without its event would leave every other
 * member's copy of the member list permanently wrong, with nothing to repair it
 * short of a full resync.
 */
export async function addMember(
  trx: Transaction<DB>, spaceId: string, actorId: string, role: 'member' | 'admin', by: string,
): Promise<MembershipResult> {
  const existing = await trx.selectFrom('memberships').select('left_at')
    .where('scope_type', '=', 'space').where('scope_id', '=', spaceId)
    .where('actor_id', '=', actorId)
    .forUpdate()
    .executeTakeFirst();
  if (existing && existing.left_at === null) return { status: 'already_member' };

  await trx.insertInto('memberships')
    .values({ scope_type: 'space', scope_id: spaceId, actor_id: actorId, role })
    .onConflict(oc => oc.columns(['scope_type', 'scope_id', 'actor_id'])
      // Re-adding is not promotion. A tombstoned admin row must come back as
      // the role this operation grants, or any member could restore an admin
      // without passing the separate `promote` permission.
      .doUpdateSet({ role, left_at: null, joined_at: sql`now()` }))
    .execute();

  const allocated = await allocateStream(trx, spaceStream(spaceId));
  const event = await appendEvent(trx, allocated, 'space.member_added', {
    actor_id: actorId, role, by_actor_id: by,
    hydration: await hydrationSnapshot(trx, spaceId, allocated.rev),
  }, { kind: 'stream' });
  return { status: 'added', event };
}

/**
 * The space's current shape, carried on every `space.member_added` event so
 * the NAMED actor's own replica can render it without waiting for a
 * reconnect. Every recipient gets the same payload — the client decides
 * whether it applies (SPACE-MEMBERSHIP-MARKERS.md); this is not a
 * per-recipient redaction, since `fanout.ts` delivers one payload to everyone
 * entitled to the stream.
 */
async function hydrationSnapshot(
  trx: Transaction<DB>, spaceId: string, spaceRev: number,
): Promise<SpaceMemberAdded['hydration']> {
  const space = await trx.selectFrom('spaces')
    .select(['id', 'kind', 'name', 'slug', 'visibility', 'membership_policy', 'lifecycle',
             'created_by_actor_id', 'on_behalf_of_actor_id', 'dm_key'])
    .where('id', '=', spaceId).executeTakeFirstOrThrow();
  const chats = await trx.selectFrom('chats')
    .select(['id', 'space_id', 'kind', 'name', 'next_ord', 'next_rev'])
    .where('space_id', '=', spaceId).where('kind', 'in', ['sole', 'default', 'public'])
    .execute();

  // A room's panels come too, so someone added mid-way sees what everyone is
  // already working beside — the same set `welcome` would give them.
  const panels = space.kind === 'room' ? await roomPanels(trx, [spaceId]) : [];

  const { dm_key: key, ...row } = space;
  return {
    space: { ...row, member_ids: dmMembers(key), rev: spaceRev },
    chats: chats.map(chat => ({
      id: chat.id, space_id: chat.space_id, kind: chat.kind, name: chat.name,
      head_ord: chat.next_ord, head_rev: chat.next_rev,
    })),
    ...(panels.length > 0 ? { panels } : {}),
  };
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

/**
 * The addressee must be an active actor in the space's workspace, with the
 * workspace membership that forms the leading containment conjunct.
 *
 * Checked after the adder's permission so an unreachable space cannot be used
 * to probe actor ids. The one answer covers unknown, cross-workspace, removed,
 * suspended and deactivated actors; none is useful to distinguish here.
 */
async function requireAddableActor(
  db: Kysely<DB>, spaceId: string, actorId: string,
): Promise<void> {
  const actor = await db.selectFrom('actors')
    .innerJoin('spaces', 'spaces.workspace_id', 'actors.workspace_id')
    .innerJoin('memberships', join => join
      .on('memberships.scope_type', '=', 'workspace')
      .onRef('memberships.scope_id', '=', 'spaces.workspace_id')
      .onRef('memberships.actor_id', '=', 'actors.id')
      .on('memberships.left_at', 'is', null))
    .select('actors.id')
    .where('spaces.id', '=', spaceId)
    .where('actors.id', '=', actorId)
    .where('actors.state', '=', 'active')
    .executeTakeFirst();
  if (!actor) throw new SpaceMemberUnavailableError(actorId);
}

const isConstraint = (err: unknown, name: string): boolean =>
  typeof err === 'object' && err !== null
  && (err as { constraint?: string }).constraint === name;
