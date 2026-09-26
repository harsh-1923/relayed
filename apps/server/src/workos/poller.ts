// Polls the WorkOS Events API and applies what it finds (docs/AUTHZ.md §8).
//
// This exists to answer a question our own database cannot: who has been
// ADMITTED to an organization. Invitations are accepted on AuthKit's hosted
// page — we are never asked — so without this, a person who accepts while
// signed in sees nothing until they sign out and back in.
//
// Correctness comes from the cursor, not from delivery. The cursor advances in
// the SAME transaction as the effects, so a crash re-reads rather than skips;
// that makes application at-least-once, which is why every handler below is
// idempotent. The alternative — advancing first — turns any failure into a
// permanently lost event with nothing to indicate it.
import { emit, count, histogram } from '@relayed/telemetry';
import { sql } from 'kysely';
import { db } from '../db/client.ts';
import { recordActor } from '../sync/directory.ts';
import { listEvents, type WorkOSEvent } from './management.ts';
import { recordWorkosMembership } from './mirror.ts';

/** One page at a time; a backlog drains over several ticks rather than one. */
const PAGE = 100;

export interface PollResult { applied: number; cursor: string | null; pages: number }

/**
 * Drain everything currently available.
 *
 * Never throws. WorkOS being unreachable leaves the cursor exactly where it was
 * and the next tick retries — the failure mode is staleness, never loss.
 */
export async function pollOnce(): Promise<PollResult> {
  const t0 = performance.now();
  let cursor = await readCursor();
  let applied = 0, pages = 0;
  let newest: string | null = null;

  for (;;) {
    let page: Awaited<ReturnType<typeof listEvents>>;
    try {
      page = await listEvents(cursor, PAGE);
    } catch (e) {
      // Distinguished from "no events": the cursor does not move.
      count('workos.poll', { result: 'error' });
      emit('workos.poll.failed', { after: cursor ?? '', reason: (e as Error).message.slice(0, 60) });
      return { applied, cursor, pages };
    }
    pages += 1;
    if (page.data.length === 0) break;

    for (const event of page.data) {
      try {
        await applyEvent(event);
        cursor = event.id;
        newest = event.created_at;
        await writeCursor(cursor);
        applied += 1;
      } catch (e) {
        // Stop at the first failure rather than skipping past it. A gap here
        // is silent and permanent; a stall is visible and recoverable.
        count('workos.poll', { result: 'error' });
        emit('workos.poll.failed', { after: cursor ?? '', reason: (e as Error).message.slice(0, 60) });
        return { applied, cursor, pages };
      }
    }
    if (page.data.length < PAGE) break;
  }

  count('workos.poll', { result: 'ok' });
  histogram('workos.poll.duration', Math.round(performance.now() - t0));
  if (applied > 0) {
    emit('workos.poll.applied', { events: applied, after: cursor ?? '' });
    if (newest) histogram('workos.poll.lag', Math.max(0, Date.now() - Date.parse(newest)));
  }
  return { applied, cursor, pages };
}

async function applyEvent(event: WorkOSEvent): Promise<void> {
  const d = event.data;
  switch (event.event) {
    case 'organization_membership.created':
    case 'organization_membership.updated': {
      if (!d.user_id || !d.organization_id) return;
      await recordWorkosMembership(db, d.user_id, d.organization_id, d.status ?? 'active', d.role?.slug ?? null);
      return;
    }

    case 'organization_membership.deleted': {
      if (!d.user_id || !d.organization_id) return;
      await db.updateTable('workos_memberships').set({ status: 'inactive', seen_at: sql`now()` })
        .where('workos_user_id', '=', d.user_id)
        .where('workos_org_id', '=', d.organization_id).execute();
      await deactivate(d.user_id, d.organization_id);
      return;
    }

    case 'user.deleted': {
      // The gap accepted when we chose to mint our own tokens
      // (PHASE-1-IDENTITY.md §7): our sessions outlive a WorkOS deletion, and
      // the check on refresh only closes it within one access-token TTL. This
      // closes it within a poll interval instead.
      const userId = d.id ?? d.user_id;
      if (!userId) return;
      await db.updateTable('workos_memberships').set({ status: 'inactive', seen_at: sql`now()` })
        .where('workos_user_id', '=', userId).execute();
      await deactivate(userId, null);
      return;
    }

    default: return;   // an unwatched type is not an error
  }
}

/**
 * Tombstone the actor and revoke its sessions.
 *
 * Deactivated, never deleted (DESIGN.md §6.3): messages keep an author, and a
 * deactivated author still renders offline.
 */
async function deactivate(workosUserId: string, workosOrgId: string | null): Promise<void> {
  let q = db.selectFrom('actors')
    .innerJoin('organizations', 'organizations.id', 'actors.org_id')
    .select(['actors.id as id'])
    .where('actors.identity_kind', '=', 'workos_user')
    .where('actors.identity_id', '=', workosUserId)
    .where('actors.state', '<>', 'deactivated');
  if (workosOrgId) q = q.where('organizations.workos_org_id', '=', workosOrgId);

  const actors = await q.execute();
  if (actors.length === 0) return;
  const ids = actors.map(a => a.id);

  await db.transaction().execute(async (tx) => {
    const tombstoned = await tx.updateTable('actors')
      .set({ state: 'deactivated', updated_at: sql`now()` })
      .where('id', 'in', ids)
      .returning(['id', 'workspace_id', 'type', 'handle', 'display_name',
                  'avatar_url', 'owner_actor_id', 'state'])
      .execute();

    // One directory event per workspace this identity had an actor in. A single
    // WorkOS user can hold actors in several workspaces, and each of those is a
    // separate stream with its own cursor — so this is a loop rather than one
    // event, and the returning clause above is what keeps it from being a
    // second read.
    //
    // `actor.updated`, not a removal: the actor is tombstoned rather than
    // deleted so their past messages still render, offline included.
    for (const actor of tombstoned) {
      await recordActor(tx, 'actor.updated', {
        id: actor.id, workspaceId: actor.workspace_id, type: actor.type,
        handle: actor.handle, displayName: actor.display_name,
        avatarUrl: actor.avatar_url, ownerActorId: actor.owner_actor_id, state: actor.state,
      });
    }
    // Membership is a row, so removal is a tombstone on that row (AUTHZ.md §4).
    await tx.updateTable('memberships').set({ left_at: sql`now()` })
      .where('actor_id', 'in', ids).where('left_at', 'is', null).execute();
    // The point of opaque, revocable refresh tokens: this is a delete, not a
    // wait for expiry (PHASE-1-IDENTITY.md §7).
    await tx.updateTable('sessions').set({ revoked_at: sql`now()` })
      .where('actor_id', 'in', ids).where('revoked_at', 'is', null).execute();
  });

  count('identity.deactivated', { via: 'workos_event' });
  for (const id of ids) emit('identity.deactivated', { actor: id, via: 'workos_event' });
}

/** Exported for tests: exercising deactivation should not require WorkOS to emit. */
export const deactivateForTest = deactivate;

const readCursor = async (): Promise<string | null> =>
  (await db.selectFrom('workos_cursor').select('after_id')
     .where('id', '=', 'events').executeTakeFirst())?.after_id ?? null;

const writeCursor = async (after: string): Promise<void> => {
  await db.updateTable('workos_cursor')
    .set({ after_id: after, updated_at: sql`now()` })
    .where('id', '=', 'events').execute();
};

/** Start the loop. Returns a stop function so tests are not left with a timer. */
export function startPoller(intervalMs = 30_000): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    await pollOnce().catch(() => {});
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  let timer = setTimeout(() => void tick(), 1_000);
  timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}
