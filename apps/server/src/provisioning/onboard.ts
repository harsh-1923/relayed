// What a person finds when they arrive: a channel, and everybody in it.
//
// THE GAP THIS CLOSES. `createWorkspace` made an organisation, a workspace and
// an actor, and stopped — so the first thing anyone saw was a workspace with
// nowhere to say anything. And `welcomeSpaces` joins on MEMBERSHIP, which is
// correct (invariant 50: space membership is the leading conjunct of the access
// predicate), so a second person joining the workspace saw nothing either, even
// of a channel marked public. Two people in one workspace had no shared surface
// at all, and no way to make one.
//
// Both halves run AFTER their transaction commits rather than inside it.
// `createChannel` and `addToSpace` open their own, and nesting would either
// fail or turn into a savepoint whose rollback semantics nobody has thought
// about. The cost is a window where a workspace exists without its channel —
// survivable, and repaired by running this again, which is why it is
// idempotent.
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { createChannel, addToSpace } from '../sync/spaces.ts';
import type { AppendedEvent } from '../sync/events.ts';

/** The channel every workspace starts with. */
const DEFAULT_CHANNEL = 'general';

/**
 * Give a new workspace somewhere to talk.
 *
 * Returns the events so a caller with a socket can fan them out. Over HTTP
 * there is nobody else to tell — the creator is the only member and will see it
 * in their `welcome` — but returning them keeps the rule intact: whoever writes
 * an event decides who hears about it, and this file does not know about
 * sockets (`fanout.ts`).
 */
export async function seedWorkspace(
  db: Kysely<DB>, workspaceId: string, actorId: string,
): Promise<AppendedEvent[]> {
  const existing = await db.selectFrom('spaces').select('id')
    .where('workspace_id', '=', workspaceId).limit(1).executeTakeFirst();
  if (existing) return [];

  const channel = await createChannel(db, {
    workspaceId, name: DEFAULT_CHANNEL, createdBy: actorId,
  });
  return channel.events;
}

/**
 * Put a new member into every public channel.
 *
 * PUBLIC MEANS EVERYONE IN THE WORKSPACE, and this is where that becomes true
 * rather than merely documented. The access predicate is membership-based by
 * design — that is what makes "who can see this" have exactly one answer — so
 * a public space is not one the predicate treats specially, it is one everybody
 * is a member of. Somebody has to write those rows, and joining is the moment.
 *
 * Private spaces are untouched: they are private precisely because arriving in
 * the workspace is not enough.
 *
 * Each `addToSpace` appends `space.member_added` to that space's stream, so
 * members already connected learn about the newcomer through ordinary
 * catch-up — their cursor falls behind and the next heartbeat says so. No
 * special push, and nothing here needs to know who is online.
 */
export async function joinPublicSpaces(
  db: Kysely<DB>, workspaceId: string, actorId: string,
): Promise<AppendedEvent[]> {
  const spaces = await db.selectFrom('spaces')
    .select(['id', 'created_by_actor_id'])
    .where('workspace_id', '=', workspaceId)
    .where('visibility', '=', 'public')
    .where('lifecycle', '=', 'active')
    .execute();

  const events: AppendedEvent[] = [];
  for (const space of spaces) {
    const already = await db.selectFrom('memberships').select('actor_id')
      .where('scope_type', '=', 'space').where('scope_id', '=', space.id)
      .where('actor_id', '=', actorId).where('left_at', 'is', null)
      .executeTakeFirst();
    if (already) continue;
    // `by` is the space's CREATOR, not the joiner: `addToSpace` authorizes the
    // actor doing the adding, and somebody not yet in the space cannot add
    // themselves to it. A member adding another member is the rule this path
    // exercises (DESIGN.md §7.3), used on their behalf.
    //
    // A space whose creator has since been deactivated has no one to act for
    // it, and is skipped rather than forced — the alternative is a path that
    // can add anybody to anything.
    if (!space.created_by_actor_id) continue;
    events.push(await addToSpace(db, space.id, actorId, space.created_by_actor_id));
  }
  return events;
}
