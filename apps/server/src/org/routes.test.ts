// Integration: the org routes over HTTP (docs/ORG-DOMAINS.md §10) — who may
// see, approve and change what. WorkOS is a fake behind `fetch`; the routes,
// database and authorization are real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { signAccessToken } from '../auth/tokens.ts';
import { authRoutes } from '../auth/routes.ts';
import { invitationRoutes } from '../auth/invitations.ts';
import { orgRoutes } from './routes.ts';
import { createWorkspace, createWorkspaceInOrg, type Identity } from '../provisioning/provision.ts';
import { joinWorkspace } from '../provisioning/join.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const tag = ulid('t').slice(-8).toLowerCase();
const DOMAIN = `acme-${tag}.test`;
const person = (name: string): Identity => ({
  workosUserId: `wu_${name}_${tag}`, email: `${name}@${DOMAIN}`, emailVerified: true,
  displayName: name, avatarUrl: null,
});
const asha = person('asha'), ravi = person('ravi');

const W = {
  seq: 0,
  members: [] as { user_id: string; organization_id: string }[],
  invitations: [] as { id: string; email: string; state: string; organization_id: string; expires_at: string; accept_invitation_url: string }[],
};
const original = globalThis.fetch;
let app: FastifyInstance;
let acme: Awaited<ReturnType<typeof createWorkspace>>;
let leadership: Awaited<ReturnType<typeof createWorkspaceInOrg>>;
let ashaToken = '', raviToken = '';

before(async () => {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.host !== 'api.workos.com') return original(input, init);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, string> : {};
    const json = (x: unknown) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/organizations') return json({ id: `wo_${tag}_${++W.seq}`, name: body['name'] });
    if (init?.method === 'POST' && u.pathname === '/user_management/organization_memberships') {
      W.members.push({ user_id: body['user_id']!, organization_id: body['organization_id']! });
      return json({ id: `om_${++W.seq}` });
    }
    if (u.pathname === '/user_management/organization_memberships') {
      return json({ data: W.members.filter(m => m.user_id === u.searchParams.get('user_id')) });
    }
    if (u.pathname.startsWith('/user_management/users/')) {
      const id = decodeURIComponent(u.pathname.split('/').pop()!);
      const who = [asha, ravi].find(p => p.workosUserId === id);
      return json({ id, email: who?.email, email_verified: true, first_name: who?.displayName });
    }
    if (u.pathname === '/user_management/invitations' && init?.method === 'POST') {
      const inv = { id: `inv_${tag}_${++W.seq}`, email: body['email']!, state: 'pending',
                    organization_id: body['organization_id']!, expires_at: '2030-01-01', accept_invitation_url: 'x' };
      W.invitations.push(inv);
      return json(inv);
    }
    if (u.pathname === '/user_management/invitations') {
      return json({ data: W.invitations.filter(i => i.organization_id === u.searchParams.get('organization_id')) });
    }
    throw new Error(`unhandled WorkOS call ${u.pathname}`);
  }) as typeof fetch;
  if (!up) return;

  app = Fastify();
  await app.register(authRoutes);
  await app.register(invitationRoutes);
  await app.register(orgRoutes);
  await app.ready();

  acme = await createWorkspace(db, asha, { workspaceName: 'Acme', handle: 'asha' });
  leadership = await createWorkspaceInOrg(db, asha, acme.orgId,
    { workspaceName: 'Leadership', handle: 'asha', joinPolicy: 'invite_only' });
  await db.insertInto('organization_domains').values({ org_id: acme.orgId, domain: DOMAIN, approved_by: asha.workosUserId }).execute();
  const joined = await joinWorkspace(db, ravi, acme.workspaceId, 'ravi');
  if (typeof joined !== 'object') throw new Error(`seed: ${joined}`);

  const token = (actorId: string, workspaceId: string) => signAccessToken({
    actorId, orgId: acme.orgId, workspaceId, deviceId: 'dev_org', sessionId: ulid('ses') });
  ashaToken = await token(acme.actorId, acme.workspaceId);
  raviToken = await token(joined.actorId, acme.workspaceId);
});

after(async () => {
  globalThis.fetch = original;
  if (!up) return;
  await app.close();
  const workosOrg = (await db.selectFrom('organizations').select('workos_org_id').where('id', '=', acme.orgId).executeTakeFirst())?.workos_org_id;
  if (workosOrg) await db.deleteFrom('workos_memberships').where('workos_org_id', '=', workosOrg).execute();
  await db.deleteFrom('spaces').where('org_id', '=', acme.orgId).execute();
  await db.deleteFrom('organizations').where('id', '=', acme.orgId).execute();
  await pool.end();
});

const as = (token: string) => ({ authorization: `Bearer ${token}` });

test('a member browses open workspaces only; an admin sees every one', opts, async () => {
  const member = (await app.inject({ method: 'GET', url: `/org/${acme.orgId}/workspaces`, headers: as(raviToken) })).json();
  assert.equal(member.org.is_admin, false);
  assert.deepEqual(member.workspaces.map((w: { name: string }) => w.name), ['Acme']);

  const admin = (await app.inject({ method: 'GET', url: `/org/${acme.orgId}/workspaces`, headers: as(ashaToken) })).json();
  assert.equal(admin.org.is_admin, true);
  assert.deepEqual(admin.workspaces.map((w: { name: string }) => w.name), ['Acme', 'Leadership']);
});

test('domain approval: admin only, own domain only, never public', opts, async () => {
  const post = (token: string, domain: string) =>
    app.inject({ method: 'POST', url: `/org/${acme.orgId}/domains`, headers: as(token), payload: { domain } });
  assert.equal((await post(raviToken, DOMAIN)).statusCode, 403, 'a member may not');
  assert.equal((await post(ashaToken, 'gmail.com')).json().error, 'public_domain');
  assert.equal((await post(ashaToken, 'other.test')).json().error, 'not_your_domain');
  const ok = await post(ashaToken, DOMAIN.toUpperCase());
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json().domains.map((d: { domain: string }) => d.domain), [DOMAIN]);
});

test('workspace settings: admins only, and the default stays open', opts, async () => {
  const patch = (token: string, id: string, payload: object) =>
    app.inject({ method: 'PATCH', url: `/workspaces/${id}`, headers: as(token), payload });
  assert.equal((await patch(raviToken, leadership.workspaceId, { join_policy: 'org_open' })).statusCode, 403);
  assert.equal((await patch(ashaToken, acme.workspaceId, { join_policy: 'invite_only' })).json().error, 'default_must_be_open');
  assert.equal((await patch(ashaToken, leadership.workspaceId, { join_policy: 'org_open' })).statusCode, 200);
  const ws = await db.selectFrom('workspaces').select('join_policy').where('id', '=', leadership.workspaceId).executeTakeFirstOrThrow();
  assert.equal(ws.join_policy, 'org_open');
});

test('creating inside an org is refused to a member', opts, async () => {
  const res = await app.inject({ method: 'POST', url: '/auth/workspace', headers: as(raviToken),
    payload: { workspace_name: 'Side project', handle: 'ravi', org_id: acme.orgId, device_id: 'dev_org' } });
  assert.equal(res.statusCode, 403);
});

test('an invitation is listed only in the workspace it was sent from', opts, async () => {
  const leadToken = await signAccessToken({ actorId: leadership.actorId, orgId: acme.orgId,
    workspaceId: leadership.workspaceId, deviceId: 'dev_org', sessionId: ulid('ses') });
  const sent = await app.inject({ method: 'POST', url: '/invitations', headers: as(leadToken),
    payload: { email: `priya@${DOMAIN}` } });
  assert.equal(sent.statusCode, 200);
  const fromLead = (await app.inject({ method: 'GET', url: '/invitations', headers: as(leadToken) })).json();
  const fromDefault = (await app.inject({ method: 'GET', url: '/invitations', headers: as(ashaToken) })).json();
  assert.equal(fromLead.invitations.length, 1);
  assert.equal(fromDefault.invitations.length, 0, 'another workspace of the same org does not see it');
});

test('a domain verified in WorkOS cannot be removed from the app', opts, async () => {
  const managed = `managed-${tag}.test`;
  await db.insertInto('organization_domains').values({
    org_id: acme.orgId, domain: managed, approved_by: 'workos', verified_at: new Date(), source: 'workos',
  }).execute();
  const res = await app.inject({ method: 'DELETE', url: `/org/${acme.orgId}/domains/${managed}`, headers: as(ashaToken) });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'managed_in_workos');
  const listed = (await app.inject({ method: 'GET', url: `/org/${acme.orgId}/domains`, headers: as(ashaToken) })).json();
  assert.ok(listed.domains.some((d: { domain: string; source: string; verified: boolean }) =>
    d.domain === managed && d.source === 'workos' && d.verified));
});
