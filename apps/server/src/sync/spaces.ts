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
import { sql, type Kysely } from 'kysely';
import { can, workspace as workspaceTarget, space as spaceTarget } from '@relayed/authz';
import type { DB } from '../db/schema.ts';
import { loadGrants, Forbidden } from '../authz/can.ts';
import { spacePlacement } from './placement.ts';
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

  try {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('spaces').values({
        id: spaceId, org_id: workspace.org_id, workspace_id: input.workspaceId,
        kind: 'channel', name: input.name, slug: input.slug ?? null, topic: null,
        visibility,
        // Public means discoverable and joinable, NOT auto-joined — membership
        // stays explicit either way (DESIGN.md §7.2).
        membership_policy: visibility === 'public' ? 'open' : 'invite',
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
    });
  } catch (err) {
    if (isConstraint(err, 'space_slug')) throw new SlugTakenError(input.slug ?? '');
    throw err;
  }

  return { spaceId, chatId };
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
): Promise<void> {
  await requireSpace(db, actorId, spaceId, 'join');
  await grantMembership(db, spaceId, actorId, 'member');
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
): Promise<void> {
  await requireSpace(db, by, spaceId, 'add_member');
  await grantMembership(db, spaceId, actorId, role);
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
): Promise<void> {
  await tombstoneMembership(db, spaceId, actorId);
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
): Promise<void> {
  if (by !== actorId) await requireSpace(db, by, spaceId, 'remove_member');
  await tombstoneMembership(db, spaceId, actorId);
}

/** Members of a space who have not left. The fanout set for every chat in it. */
export async function spaceMembers(db: Kysely<DB>, spaceId: string): Promise<string[]> {
  const rows = await db.selectFrom('memberships').select('actor_id')
    .where('scope_type', '=', 'space')
    .where('scope_id', '=', spaceId)
    .where('left_at', 'is', null)
    .execute();
  return rows.map(r => r.actor_id);
}

/**
 * Write the membership row.
 *
 * Idempotent, and re-joining CLEARS `left_at` rather than inserting a second
 * row. That is what makes re-adding a removed member the gap case rather than a
 * special case: the membership resumes, the cursor is behind, and the existing
 * backfill machinery heals it (DESIGN.md §6.6).
 */
async function grantMembership(
  db: Kysely<DB>, spaceId: string, actorId: string, role: 'member' | 'admin',
): Promise<void> {
  await db.insertInto('memberships')
    .values({ scope_type: 'space', scope_id: spaceId, actor_id: actorId, role })
    .onConflict(oc => oc.columns(['scope_type', 'scope_id', 'actor_id'])
      .doUpdateSet({ left_at: null, joined_at: sql`now()` }))
    .execute();
}

/**
 * A tombstone, never a delete. "Was Alice ever in this space" stays answerable,
 * and the local copy on her device freezes rather than being recalled — removal
 * stops new data, it is not a retroactive recall (DESIGN.md §6.6).
 */
async function tombstoneMembership(
  db: Kysely<DB>, spaceId: string, actorId: string,
): Promise<void> {
  await db.updateTable('memberships')
    .set({ left_at: sql`now()` })
    .where('scope_type', '=', 'space')
    .where('scope_id', '=', spaceId)
    .where('actor_id', '=', actorId)
    .where('left_at', 'is', null)
    .execute();
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
