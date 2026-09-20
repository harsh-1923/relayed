// The world a mock run happens in: one org, one workspace, actors and channels.
//
// EVERYTHING IT CREATES IS TAGGED, so wiping is exact rather than a truncate.
// A run that could only be undone by emptying the database would be a run
// nobody dares do twice, and the whole point of this is to be re-runnable.
//
// It writes through the real functions — `createChannel`, `addToSpace`, the
// real actor rows — rather than raw inserts, because a seed that bypasses the
// domain produces a world the domain would never have made, and then the load
// exercises paths that cannot happen in production.
import { sql, type Kysely } from 'kysely';
import type { DB } from '../../apps/server/src/db/schema.ts';
import { ulid } from '../../apps/server/src/db/ulid.ts';
import { createChannel, addToSpace } from '../../apps/server/src/sync/spaces.ts';
import { recordActor } from '../../apps/server/src/sync/directory.ts';

/** The marker every mock row carries, so a wipe can find exactly them. */
export const MOCK_TAG = 'relayed-mock';

export interface World {
  orgId: string;
  workspaceId: string;
  /** Every actor, in creation order. `actors[0]` is the one who made everything. */
  actors: string[];
  /** Public channels, which everybody is in. */
  channels: { spaceId: string; chatId: string; name: string }[];
  /** Private channels, with a named subset of members. Where authz gets tested. */
  private: { spaceId: string; chatId: string; members: string[] }[];
}

export interface WorldSize {
  actors: number;
  channels: number;
  privateChannels: number;
}

/**
 * Build a world.
 *
 * Deliberately NOT idempotent: each call makes a fresh org with fresh ids, so
 * two runs never interfere and `wipe` can remove one without touching the
 * other. Re-running is `wipe` then `seed`, which is one line either way.
 */
export async function seed(db: Kysely<DB>, size: WorldSize): Promise<World> {
  const orgId = ulid('org');
  const workspaceId = ulid('wsp');

  await db.insertInto('organizations')
    .values({ id: orgId, workos_org_id: `${MOCK_TAG}_${orgId}`, name: 'Mock Load' })
    .execute();
  await db.insertInto('workspaces').values({
    id: workspaceId, org_id: orgId, name: 'Mock Load',
    slug: `mock-${workspaceId.slice(-8).toLowerCase()}`,
  }).execute();

  const actors: string[] = [];
  for (let i = 0; i < size.actors; i++) {
    const id = ulid('act');
    const displayName = NAMES[i % NAMES.length] ?? `Actor ${i}`;
    const handle = `mock-${id.slice(-8).toLowerCase()}`;
    actors.push(id);

    // THROUGH `recordActor`, in the same transaction as the row — the pairing
    // `check-boundaries` enforces on every product write site. An actor written
    // without it exists on the server and on nobody's client, and no reconnect
    // repairs that. It also means the workspace stream gets real events, so a
    // run exercises the directory rather than only the chats.
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('actors').values({
        id, org_id: orgId, workspace_id: workspaceId, type: 'human',
        handle, display_name: displayName,
        avatar_url: null, identity_kind: 'workos_user', identity_id: `${MOCK_TAG}_${id}`,
        owner_actor_id: null, provisioned_by: 'api', state: 'active',
      }).execute();
      // The workspace conjunct, which every space check sits above (AUTHZ.md §7).
      await trx.insertInto('memberships').values({
        scope_type: 'workspace', scope_id: workspaceId, actor_id: id, role: 'member',
      }).execute();
      await recordActor(trx, 'actor.created', {
        id, workspaceId, type: 'human', handle, displayName,
        avatarUrl: null, ownerActorId: null, state: 'active',
      });
    });
  }

  const owner = actors[0]!;
  const channels: World['channels'] = [];
  for (let i = 0; i < size.channels; i++) {
    const name = `${CHANNELS[i % CHANNELS.length]}-${i}`;
    const made = await createChannel(db, { workspaceId, name, createdBy: owner });
    channels.push({ spaceId: made.spaceId, chatId: made.chatId, name });
    // Everybody, so fanout has a real audience rather than a pair.
    for (const actor of actors.slice(1)) {
      await addToSpace(db, made.spaceId, actor, owner, ulid('msg'));
    }
  }

  const privates: World['private'] = [];
  for (let i = 0; i < size.privateChannels; i++) {
    const made = await createChannel(db, {
      workspaceId, name: `private-${i}`, visibility: 'private', createdBy: owner,
    });
    // A THIRD of the workspace. The rest are in the workspace and not in here,
    // which is what makes a refused write reachable at all — and a refusal is
    // the edge case with no other way to produce it.
    const members = [owner, ...actors.slice(1, Math.max(2, Math.ceil(actors.length / 3)))];
    for (const actor of members.slice(1)) {
      await addToSpace(db, made.spaceId, actor, owner, ulid('msg'));
    }
    privates.push({ spaceId: made.spaceId, chatId: made.chatId, members });
  }

  return { orgId, workspaceId, actors, channels, private: privates };
}

/** Every mock org currently in the database, oldest first. */
export async function mockOrgs(db: Kysely<DB>): Promise<string[]> {
  const rows = await db.selectFrom('organizations').select('id')
    .where('workos_org_id', 'like', `${MOCK_TAG}_%`).orderBy('id').execute();
  return rows.map(row => row.id);
}

/**
 * Remove a mock org and everything under it.
 *
 * `sync_events` first and by hand: it cascades from `workspaces`, but the
 * cascade runs as one statement over what can be millions of rows, and a
 * bounded loop is the difference between a wipe and a lock-up. Same reasoning
 * as the retention sweep.
 */
export async function wipe(db: Kysely<DB>, orgId: string): Promise<{ events: number }> {
  const workspaces = await db.selectFrom('workspaces').select('id')
    .where('org_id', '=', orgId).execute();

  let events = 0;
  for (const workspace of workspaces) {
    for (;;) {
      const { rows } = await sql<{ n: string }>`
        WITH doomed AS (
          SELECT event_id FROM sync_events WHERE workspace_id = ${workspace.id} LIMIT 20000
        )
        DELETE FROM sync_events USING doomed WHERE sync_events.event_id = doomed.event_id
        RETURNING 1 AS n
      `.execute(db);
      events += rows.length;
      if (rows.length === 0) break;
    }

    // MESSAGES BEFORE ACTORS, because `messages.author_id` is ON DELETE
    // RESTRICT and that is correct: an actor is tombstoned and never deleted
    // precisely so their past messages keep rendering with a name (DESIGN §6.3).
    // A wipe is the one operation that genuinely wants them gone, so it works
    // WITH the constraint rather than asking for it to be loosened.
    for (;;) {
      const { rows } = await sql<{ n: string }>`
        WITH doomed AS (
          SELECT m.id FROM messages m
            JOIN chats c ON c.id = m.chat_id
            JOIN spaces s ON s.id = c.space_id
           WHERE s.workspace_id = ${workspace.id}
           LIMIT 20000
        )
        DELETE FROM messages USING doomed WHERE messages.id = doomed.id
        RETURNING 1 AS n
      `.execute(db);
      if (rows.length === 0) break;
    }
  }
  // The rest cascades from the org, and is small enough for one statement.
  await db.deleteFrom('organizations').where('id', '=', orgId).execute();
  return { events };
}

const NAMES = [
  'Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Barbara Liskov',
  'Edsger Dijkstra', 'Margaret Hamilton', 'Ken Thompson', 'Radia Perlman',
  'Leslie Lamport', 'Karen Sparck Jones', 'Tony Hoare', 'Frances Allen',
];
const CHANNELS = [
  'general', 'engineering', 'design', 'incidents', 'random', 'product',
  'support', 'hiring', 'releases', 'watercooler',
];
