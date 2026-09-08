// Integration: exercises issuance, /auth/me, refresh rotation and sign-out
// against a real Postgres. Requires `pnpm services` and a running server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { signAccessToken, newRefreshToken, hashRefreshToken } from './tokens.ts';

const BASE = process.env['SERVER_URL'] ?? 'http://127.0.0.1:8787';
const ids = { org: ulid('org'), wsp: ulid('wsp'), act: ulid('act') };
let refresh = '';

// This suite talks to a running server and a real Postgres. It SKIPS rather
// than fails when they are absent, so `pnpm test` stays green on a machine
// without the stack up — a red suite that means "you forgot docker" trains
// people to ignore red suites.
const reachable = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
  .then(r => r.ok).catch(() => false);
const opts = reachable ? {} : { skip: 'server not reachable — run `pnpm services` and `pnpm dev`' };

before(async () => {
  if (!reachable) return;
  await db.insertInto('organizations').values({
    id: ids.org, workos_org_id: `test_${ids.org}`, name: 'Test Co' }).execute();
  await db.insertInto('workspaces').values({
    id: ids.wsp, org_id: ids.org, name: 'Test Co', slug: `t-${ids.wsp.slice(-6)}` }).execute();
  await db.insertInto('actors').values({
    id: ids.act, org_id: ids.org, workspace_id: ids.wsp, type: 'human',
    handle: `t${ids.act.slice(-8).toLowerCase()}`, display_name: 'Test Person',
    avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${ids.act}`,
    owner_actor_id: null, provisioned_by: 'self_signup', state: 'active' }).execute();

  refresh = newRefreshToken();
  await db.insertInto('sessions').values({
    id: ulid('ses'), actor_id: ids.act, device_id: 'dev_test',
    refresh_hash: hashRefreshToken(refresh),
    expires_at: new Date(Date.now() + 3600_000), revoked_at: null }).execute();
});

after(async () => {
  if (!reachable) return;
  await db.deleteFrom('organizations').where('id', '=', ids.org).execute();
  await pool.end();
});

test('/auth/me resolves an actor from our own token', opts, async () => {
  const token = await signAccessToken({
    actorId: ids.act, workspaceId: ids.wsp, orgId: ids.org,
    deviceId: 'dev_test', sessionId: 'ses_test' });
  const r = await fetch(`${BASE}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  const j = await r.json() as { actor: { id: string }; device_id: string };
  assert.equal(j.actor.id, ids.act);
  assert.equal(j.device_id, 'dev_test', 'device identity survives the round trip');
});

test('refresh issues a new pair and ROTATES the old one', opts, async () => {
  const r = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }) });
  assert.equal(r.status, 200);
  const j = await r.json() as { access_token: string; refresh_token: string };
  assert.ok(j.access_token && j.refresh_token);
  assert.notEqual(j.refresh_token, refresh, 'refresh token must rotate');

  // The old token is dead immediately — a stolen one stops working the moment
  // the legitimate client refreshes.
  const replay = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }) });
  assert.equal(replay.status, 401, 'replaying a rotated refresh token must fail');
  refresh = j.refresh_token;
});

test('a deactivated actor cannot refresh', opts, async () => {
  await db.updateTable('actors').set({ state: 'deactivated' }).where('id', '=', ids.act).execute();
  const r = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }) });
  assert.equal(r.status, 403, 'refresh is the backstop for a deactivation we have not webhooked yet');
  await db.updateTable('actors').set({ state: 'active' }).where('id', '=', ids.act).execute();
});

test('sign-out revokes only that device session', opts, async () => {
  const r = await fetch(`${BASE}/auth/signout`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }) });
  assert.equal(r.status, 200);
  const after = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }) });
  assert.equal(after.status, 401);
});

test('the refresh token is never stored in the clear', opts, async () => {
  const rows = await db.selectFrom('sessions').select(['refresh_hash'])
    .where('actor_id', '=', ids.act).execute();
  assert.ok(rows.length > 0);
  for (const row of rows) assert.notEqual(row.refresh_hash, refresh);
});
