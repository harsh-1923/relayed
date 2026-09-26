// Integration: the WorkOS event mirror (docs/AUTHZ.md §8).
//
// The design rests on the cursor, not on delivery, so these test the cursor's
// properties rather than that "an event arrived".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, pool } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { pollOnce } from './poller.ts';
import { pendingJoins } from '../provisioning/join.ts';
import { eventsSince } from '../sync/feed.ts';
import { workspaceStream } from '../sync/events.ts';

const BASE = process.env['SERVER_URL'] ?? 'http://127.0.0.1:8787';
const reachable = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
  .then(r => r.ok).catch(() => false);
const opts = reachable ? {} : { skip: 'server not reachable — run `pnpm services` and `pnpm dev`' };

const ids = { org: ulid('org'), wsp: ulid('wsp'), act: ulid('act') };
const workosOrg = `test_org_${ids.org}`;
const workosUser = `test_user_${ids.act}`;

before(async () => {
  if (!reachable) return;
  await db.insertInto('organizations').values({
    id: ids.org, workos_org_id: workosOrg, name: 'Poller Test', avatar_url: null }).execute();
  await db.insertInto('workspaces').values({
    id: ids.wsp, org_id: ids.org, name: 'Poller Test',
    slug: `p-${ids.wsp.slice(-6).toLowerCase()}`, avatar_url: null, join_policy: 'org_open' }).execute();
  // An org member is offered its DEFAULT workspace (ORG-DOMAINS.md §5.1).
  await db.updateTable('organizations').set({ default_workspace_id: ids.wsp })
    .where('id', '=', ids.org).execute();
});

after(async () => {
  if (!reachable) return;
  await db.deleteFrom('workos_memberships').where('workos_user_id', '=', workosUser).execute();
  await db.deleteFrom('organizations').where('id', '=', ids.org).execute();
  await pool.end();
});

const identity = { workosUserId: workosUser, email: 'poller@test.invalid',
                   displayName: 'Poller Test', avatarUrl: null };

test('a drain is idempotent — replaying applies nothing new', opts, async () => {
  // At-least-once is the contract, because the cursor advances with the effects
  // rather than before them. That is only safe if applying twice is harmless.
  const first = await pollOnce();
  const second = await pollOnce();
  assert.equal(second.applied, 0, 'a second drain applied events again');
  assert.equal(second.cursor, first.cursor, 'the cursor moved with nothing to apply');
});

test('an unreachable WorkOS leaves the cursor exactly where it was', opts, async () => {
  const before_ = (await db.selectFrom('workos_cursor').select('after_id')
    .where('id', '=', 'events').executeTakeFirst())?.after_id ?? null;

  const key = process.env['WORKOS_API_KEY'];
  delete process.env['WORKOS_API_KEY'];
  try {
    const r = await pollOnce();
    assert.equal(r.applied, 0);
  } finally {
    if (key) process.env['WORKOS_API_KEY'] = key;
  }

  const after_ = (await db.selectFrom('workos_cursor').select('after_id')
    .where('id', '=', 'events').executeTakeFirst())?.after_id ?? null;
  // The failure mode is staleness, never a silently skipped event.
  assert.equal(after_, before_);
});

test('the mirror answers pendingJoins without calling WorkOS', opts, async () => {
  // Nothing in the mirror: nothing pending, even though the workspace exists.
  assert.deepEqual(await pendingJoins(db, identity, 'mirror'), []);

  await db.insertInto('workos_memberships').values({
    workos_user_id: workosUser, workos_org_id: workosOrg,
    role_slug: 'member', status: 'active' }).execute();

  const joins = await pendingJoins(db, identity, 'mirror');
  assert.equal(joins.length, 1);
  assert.equal(joins[0]?.workspaceId, ids.wsp);
  assert.ok(joins[0]!.handleSuggestions.length > 0, 'a join screen with no suggestions asks people to invent one');
});

test('only ACTIVE memberships are pending joins', opts, async () => {
  await db.updateTable('workos_memberships').set({ status: 'pending' })
    .where('workos_user_id', '=', workosUser).execute();
  assert.deepEqual(await pendingJoins(db, identity, 'mirror'), [],
    'an invitation that was sent but not accepted is not a join');

  await db.updateTable('workos_memberships').set({ status: 'inactive' })
    .where('workos_user_id', '=', workosUser).execute();
  assert.deepEqual(await pendingJoins(db, identity, 'mirror'), [],
    'a membership that was removed is not a join either');

  await db.updateTable('workos_memberships').set({ status: 'active' })
    .where('workos_user_id', '=', workosUser).execute();
});

test('a workspace already joined stops being pending', opts, async () => {
  await db.insertInto('actors').values({
    id: ids.act, org_id: ids.org, workspace_id: ids.wsp, type: 'human',
    handle: `p${ids.act.slice(-8).toLowerCase()}`, display_name: 'Poller Test',
    avatar_url: null, identity_kind: 'workos_user', identity_id: workosUser,
    owner_actor_id: null, provisioned_by: 'invite', state: 'active' }).execute();

  assert.deepEqual(await pendingJoins(db, identity, 'mirror'), [],
    'the actor exists, so there is nothing left to join');
});

test('deactivation tombstones the actor, its membership and its sessions', opts, async () => {
  await db.insertInto('memberships').values({
    scope_type: 'workspace', scope_id: ids.wsp, actor_id: ids.act,
    role: 'member', left_at: null }).execute();
  const refreshHash = `hash_${ids.act}`;
  await db.insertInto('sessions').values({
    id: ulid('ses'), actor_id: ids.act, device_id: 'dev_poller',
    refresh_hash: refreshHash, expires_at: new Date(Date.now() + 3600_000),
    revoked_at: null }).execute();

  // What `user.deleted` does, without needing WorkOS to emit one.
  const { deactivateForTest } = await import('./poller.ts');
  await deactivateForTest(workosUser, null);

  const actor = await db.selectFrom('actors').select('state')
    .where('id', '=', ids.act).executeTakeFirst();
  assert.equal(actor?.state, 'deactivated', 'tombstoned, never deleted — messages keep an author');

  const live = await db.selectFrom('memberships').select('actor_id')
    .where('actor_id', '=', ids.act).where('left_at', 'is', null).execute();
  assert.deepEqual(live, [], 'the permission row is tombstoned too');

  const session = await db.selectFrom('sessions').select('revoked_at')
    .where('refresh_hash', '=', refreshHash).executeTakeFirst();
  assert.ok(session?.revoked_at, 'the whole point of revocable refresh tokens: a delete, not a wait');

  // The directory has to learn about this, or every other member's client keeps
  // rendering them as active for ever. There is no error and no reconnect that
  // repairs it: catch-up returns the events that were written, not the rows
  // that were quietly changed without one.
  const directory = await eventsSince(db, ids.act, workspaceStream(ids.wsp), 0);
  const tombstone = directory.at(-1);
  assert.equal(tombstone?.type, 'actor.updated',
    'an update, not a removal — the row survives so old messages keep an author');
  assert.equal((tombstone?.payload as { id: string }).id, ids.act);
  assert.equal((tombstone?.payload as { state: string }).state, 'deactivated');

  await db.deleteFrom('sessions').where('refresh_hash', '=', refreshHash).execute();
  await sql`SELECT 1`.execute(db);
});
