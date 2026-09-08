// Integration: one identity in two workspaces (STORAGE.md §10).
//
// The scenario is the real one — an email that created an org and was later
// invited to a second — which is what turned resolveActor's unordered
// executeTakeFirst() from a latent defect into a live one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { newRefreshToken, hashRefreshToken } from './tokens.ts';
import { resolveMemberships, selectMembership, type Membership } from '../provisioning/provision.ts';

const BASE = process.env['SERVER_URL'] ?? 'http://127.0.0.1:8787';

// One identity, two workspaces. Plus a third workspace belonging to somebody
// else, which is what proves /auth/switch is scoped rather than open.
const identity = `wu_${ulid('id')}`;
const stranger = `wu_${ulid('id')}`;
const a = { org: ulid('org'), wsp: ulid('wsp'), act: ulid('act') };
const b = { org: ulid('org'), wsp: ulid('wsp'), act: ulid('act') };
const x = { org: ulid('org'), wsp: ulid('wsp'), act: ulid('act') };
let refreshA = '';

const reachable = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
  .then(r => r.ok).catch(() => false);
const opts = reachable ? {} : { skip: 'server not reachable — run `pnpm services` and `pnpm dev`' };

async function seed(
  t: { org: string; wsp: string; act: string }, name: string, handle: string, id: string,
) {
  await db.insertInto('organizations').values({
    id: t.org, workos_org_id: `test_${t.org}`, name }).execute();
  await db.insertInto('workspaces').values({
    id: t.wsp, org_id: t.org, name, slug: `t-${t.wsp.slice(-6).toLowerCase()}` }).execute();
  await db.insertInto('actors').values({
    id: t.act, org_id: t.org, workspace_id: t.wsp, type: 'human',
    handle, display_name: 'Test Person', avatar_url: null,
    identity_kind: 'workos_user', identity_id: id,
    owner_actor_id: null, provisioned_by: 'self_signup', state: 'active' }).execute();
}

before(async () => {
  if (!reachable) return;
  // Seeded in order, so "oldest first" has a defined answer to check against.
  await seed(a, 'First Workspace', `t${a.act.slice(-8).toLowerCase()}`, identity);
  await seed(b, 'Acme Inc', `t${b.act.slice(-8).toLowerCase()}`, identity);
  await seed(x, 'Someone Else', `t${x.act.slice(-8).toLowerCase()}`, stranger);

  refreshA = newRefreshToken();
  await db.insertInto('sessions').values({
    id: ulid('ses'), actor_id: a.act, device_id: 'dev_multi',
    refresh_hash: hashRefreshToken(refreshA),
    expires_at: new Date(Date.now() + 3600_000), revoked_at: null }).execute();
});

after(async () => {
  if (!reachable) return;
  for (const t of [a, b, x]) {
    await db.deleteFrom('organizations').where('id', '=', t.org).execute();
  }
  await pool.end();
});

const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('one identity resolves to EVERY workspace it belongs to', opts, async () => {
  const found = await resolveMemberships(db, identity);
  assert.deepEqual(found.map(m => m.workspaceId), [a.wsp, b.wsp]);
  assert.equal(found[0]?.name, 'First Workspace');
  assert.equal(found[1]?.name, 'Acme Inc');
  // Handles differ per workspace by design, and both are carried.
  assert.notEqual(found[0]?.handle, found[1]?.handle);
});

test('resolution is deterministic, not merely repeatable', opts, async () => {
  // The defect this replaces returned an arbitrary row: stable in testing,
  // undefined by contract, free to change after a vacuum (STORAGE.md §10.1).
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    seen.add((await resolveMemberships(db, identity))[0]!.workspaceId);
  }
  assert.deepEqual([...seen], [a.wsp], 'the oldest membership, every time');
});

test('a deactivated actor drops out of the membership list', opts, async () => {
  await db.updateTable('actors').set({ state: 'deactivated' }).where('id', '=', b.act).execute();
  assert.deepEqual((await resolveMemberships(db, identity)).map(m => m.workspaceId), [a.wsp]);
  await db.updateTable('actors').set({ state: 'active' }).where('id', '=', b.act).execute();
});

test('selectMembership prefers the requested workspace, and refuses a foreign one', () => {
  const list = [
    { workspaceId: 'wsp_1' }, { workspaceId: 'wsp_2' },
  ] as Membership[];
  const pick = (pref?: string) => {
    const m = selectMembership(list, pref);
    return m && m !== 'not_a_member' ? m.workspaceId : m;
  };
  assert.equal(pick(), 'wsp_1', 'no preference → oldest');
  assert.equal(pick('wsp_2'), 'wsp_2');
  // Silently signing someone into a different workspace than they asked for is
  // worse than failing.
  assert.equal(pick('wsp_other'), 'not_a_member');
  assert.equal(selectMembership([], 'wsp_1'), null);
});

test('refresh carries the membership list', opts, async () => {
  const r = await post('/auth/refresh', { refresh_token: refreshA });
  assert.equal(r.status, 200);
  const j = await r.json() as { memberships: { workspace_id: string }[]; refresh_token: string };
  assert.deepEqual(j.memberships.map(m => m.workspace_id), [a.wsp, b.wsp],
    'a workspace added server-side reaches the client without a separate poll');
  refreshA = j.refresh_token;   // rotation
});

test('switch mints for the second workspace and does NOT revoke the first', opts, async () => {
  const r = await post('/auth/switch', { refresh_token: refreshA, workspace_id: b.wsp });
  assert.equal(r.status, 200);
  const j = await r.json() as { actor: { actorId: string }; refresh_token: string };
  assert.equal(j.actor.actorId, b.act);
  assert.notEqual(j.refresh_token, refreshA);

  // THE point of the endpoint (invariant 44): the workspace being switched away
  // from stays credentialed, so its outbox is still drainable and returning to
  // it needs no round trip.
  const stillA = await post('/auth/refresh', { refresh_token: refreshA });
  assert.equal(stillA.status, 200, 'the source session must survive a switch');
  refreshA = (await stillA.json() as { refresh_token: string }).refresh_token;

  // And the new session works on its own.
  const againB = await post('/auth/refresh', { refresh_token: j.refresh_token });
  assert.equal(againB.status, 200);
});

test('switch carries the device identity from the session, not the request', opts, async () => {
  const r = await post('/auth/switch', { refresh_token: refreshA, workspace_id: b.wsp });
  const { refresh_token } = await r.json() as { refresh_token: string };
  const row = await db.selectFrom('sessions').select('device_id')
    .where('refresh_hash', '=', hashRefreshToken(refresh_token)).executeTakeFirst();
  assert.equal(row?.device_id, 'dev_multi');
});

test('switch to a workspace of a different identity is refused', opts, async () => {
  const r = await post('/auth/switch', { refresh_token: refreshA, workspace_id: x.wsp });
  assert.equal(r.status, 403);
  assert.equal((await r.json() as { error: string }).error, 'not_a_member');
});

test('switch with an unknown refresh token is refused', opts, async () => {
  const r = await post('/auth/switch', { refresh_token: newRefreshToken(), workspace_id: b.wsp });
  assert.equal(r.status, 401);
});

test('switch requires both fields', opts, async () => {
  assert.equal((await post('/auth/switch', { refresh_token: refreshA })).status, 400);
  assert.equal((await post('/auth/switch', { workspace_id: b.wsp })).status, 400);
});
