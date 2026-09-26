// Integration: organizations above workspaces, and company domains
// (docs/ORG-DOMAINS.md). The org-domains spike's findings, as tests against the
// shipped code: who is OFFERED a workspace, who may ENTER one, and who governs
// the org.
//
// WorkOS is an in-memory fake behind `fetch`; everything else is the real
// database and the real functions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { createWorkspace, createWorkspaceInOrg, resolveMemberships, type Identity } from './provision.ts';
import { pendingJoins, joinWorkspace } from './join.ts';
import { orgMatches, syncWorkosDomains, syncWorkosDomainsFor } from './domains.ts';
import { adminOrgs, canOrg } from '../authz/org.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

// ── fake WorkOS ─────────────────────────────────────────────────────────────
const tag = ulid('t').slice(-8).toLowerCase();
const W = {
  seq: 0,
  members: [] as { user_id: string; organization_id: string }[],
  invitations: [] as { id: string; organization_id: string; accepted_user_id: string | null; state: string; email: string }[],
  added: [] as string[],
  /** Domains per WorkOS org, as its dashboard would have them. */
  orgDomains: {} as Record<string, { domain: string; state: string }[]>,
};
const original = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.host !== 'api.workos.com') return original(input, init);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, string> : undefined;
    const json = (x: unknown) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
    if (init?.method === 'POST' && u.pathname === '/organizations') return json({ id: `wo_${tag}_${++W.seq}`, name: body!['name'] });
    if (init?.method === 'POST' && u.pathname === '/user_management/organization_memberships') {
      W.members.push({ user_id: body!['user_id']!, organization_id: body!['organization_id']! });
      W.added.push(`${body!['user_id']}@${body!['organization_id']}`);
      return json({ id: `om_${++W.seq}`, ...body });
    }
    if (u.pathname === '/user_management/organization_memberships') {
      return json({ data: W.members.filter(m => m.user_id === u.searchParams.get('user_id')) });
    }
    if (init?.method !== 'POST' && u.pathname === '/organizations' && u.searchParams.get('domains')) {
      const d = u.searchParams.get('domains');
      return json({ data: Object.entries(W.orgDomains).filter(([, ds]) => ds.some(x => x.domain === d))
        .map(([id, domains]) => ({ id, name: 'x', domains })) });
    }
    if (init?.method !== 'POST' && u.pathname.startsWith('/organizations/')) {
      const id = decodeURIComponent(u.pathname.split('/').pop()!);
      return json({ id, name: 'x', domains: W.orgDomains[id] ?? [] });
    }
    if (u.pathname === '/user_management/invitations') {
      return json({ data: W.invitations.filter(i => i.organization_id === u.searchParams.get('organization_id')) });
    }
    throw new Error(`unhandled WorkOS call ${u.pathname}`);
  }) as typeof fetch;
});

const person = (name: string, domain = `acme-${tag}.test`, verified = true): Identity => ({
  workosUserId: `wu_${name}_${tag}`, email: `${name}@${domain}`, emailVerified: verified,
  displayName: name, avatarUrl: null,
});
const asha = person('asha'), ravi = person('ravi'), tom = person('tom'), eve = person('eve', undefined, false);
const carol = person('carol'), dev = person('dev', 'gmail.com');
const DOMAIN = `acme-${tag}.test`;
const orgs: string[] = [];
const workosOrgOf = async (orgId: string) =>
  (await db.selectFrom('organizations').select('workos_org_id').where('id', '=', orgId).executeTakeFirstOrThrow()).workos_org_id;

let acme: Awaited<ReturnType<typeof createWorkspace>>;
let payments: Awaited<ReturnType<typeof createWorkspaceInOrg>>;
let leadership: Awaited<ReturnType<typeof createWorkspaceInOrg>>;

before(async () => {
  if (!up) return;
  acme = await createWorkspace(db, asha, { workspaceName: 'Acme', handle: 'asha' });
  orgs.push(acme.orgId);
  payments = await createWorkspaceInOrg(db, asha, acme.orgId, { workspaceName: 'Acme', handle: 'asha' });
  leadership = await createWorkspaceInOrg(db, asha, acme.orgId,
    { workspaceName: 'Leadership', handle: 'asha', joinPolicy: 'invite_only' });
});

after(async () => {
  globalThis.fetch = original;
  if (!up) return;
  const workosOrgs = await db.selectFrom('organizations').select('workos_org_id').where('id', 'in', orgs).execute();
  if (workosOrgs.length) {
    await db.deleteFrom('workos_memberships').where('workos_org_id', 'in', workosOrgs.map(o => o.workos_org_id)).execute();
  }
  for (const org of orgs) {
    await db.deleteFrom('spaces').where('org_id', '=', org).execute();
    await db.deleteFrom('organizations').where('id', '=', org).execute();
  }
  await pool.end();
});

// ── creating ────────────────────────────────────────────────────────────────
test('a new org gets its first workspace as an open default, and the founder governs it', opts, async () => {
  const org = await db.selectFrom('organizations').select('default_workspace_id')
    .where('id', '=', acme.orgId).executeTakeFirstOrThrow();
  assert.equal(org.default_workspace_id, acme.workspaceId);
  const ws = await db.selectFrom('workspaces').select('join_policy').where('id', '=', acme.workspaceId).executeTakeFirstOrThrow();
  assert.equal(ws.join_policy, 'org_open');
  assert.ok((await adminOrgs(db, asha.workosUserId)).has(acme.orgId));
  // Written by us, not left to the poller (spike check 4.1).
  const mirror = await db.selectFrom('workos_memberships').select('status')
    .where('workos_user_id', '=', asha.workosUserId).executeTakeFirst();
  assert.equal(mirror?.status, 'active');
});

test('a second workspace in the org: slug suffixed, not the default, same org on the wire', opts, async () => {
  const [a, b] = await db.selectFrom('workspaces').select(['id', 'slug']).where('org_id', '=', acme.orgId)
    .where('id', 'in', [acme.workspaceId, payments.workspaceId]).orderBy('created_at').execute();
  assert.equal(a!.slug, 'acme');
  assert.equal(b!.slug, 'acme-2');
  const mine = await resolveMemberships(db, asha.workosUserId);
  const byWs = new Map(mine.map(m => [m.workspaceId, m]));
  assert.equal(byWs.get(acme.workspaceId)?.isDefault, true);
  assert.equal(byWs.get(payments.workspaceId)?.isDefault, false);
  assert.ok(mine.every(m => m.orgIsAdmin && m.orgName === 'Acme'));
});

// ── admission (spike checks 2.2–2.4) ───────────────────────────────────────
test('arriving in an org, every OPEN workspace is offered, default first — never an invite-only one', opts, async () => {
  W.members.push({ user_id: ravi.workosUserId, organization_id: await workosOrgOf(acme.orgId) });
  const joins = await pendingJoins(db, ravi);
  assert.deepEqual(joins.map(j => j.workspaceId), [acme.workspaceId, payments.workspaceId]);
  assert.deepEqual(joins.map(j => j.isDefault), [true, false]);
  assert.equal(joins[0]?.reason, 'member', 'in the org, not invited — WorkOS can add people by itself');
});

test('an org member cannot enter an invite-only workspace by id', opts, async () => {
  assert.equal(await joinWorkspace(db, ravi, leadership.workspaceId, 'ravi'), 'not_invited');
});

test('an org member may enter an open workspace they were not invited to', opts, async () => {
  const joined = await joinWorkspace(db, ravi, payments.workspaceId, 'ravi');
  assert.equal(typeof joined, 'object');
  // In the org now, so its other open workspaces stop being pending — they
  // are for Browse, or the switcher would count them forever.
  assert.deepEqual(await pendingJoins(db, ravi), []);
});

test('an invitation admits to the workspace it was sent from, and offers it', opts, async () => {
  const invId = `inv_${tag}`;
  await db.insertInto('workspace_invitations').values({
    workos_invitation_id: invId, workspace_id: leadership.workspaceId, invited_by_actor_id: leadership.actorId,
  }).execute();
  W.invitations.push({ id: invId, organization_id: await workosOrgOf(acme.orgId),
                       accepted_user_id: ravi.workosUserId, state: 'accepted', email: ravi.email });

  const joins = await pendingJoins(db, ravi);
  assert.deepEqual(joins.map(j => j.workspaceId), [leadership.workspaceId]);
  assert.equal(joins[0]?.reason, 'invited');
  assert.equal(typeof await joinWorkspace(db, ravi, leadership.workspaceId, 'ravi'), 'object');
  // Learned once, then answered from our own table.
  const row = await db.selectFrom('workspace_invitations').select('accepted_user_id')
    .where('workos_invitation_id', '=', invId).executeTakeFirstOrThrow();
  assert.equal(row.accepted_user_id, ravi.workosUserId);
});

// ── domains (spike checks 3.1–3.4, 4.1) ────────────────────────────────────
test('before approval, a colleague sees no match', opts, async () => {
  assert.deepEqual(await orgMatches(db, tom.email, true), []);
});

test('two orgs may approve one domain; sign-in lists both, largest first', opts, async () => {
  const design = await createWorkspace(db, carol, { workspaceName: 'Acme Design', handle: 'carol' });
  orgs.push(design.orgId);
  await db.insertInto('organization_domains').values([
    { org_id: acme.orgId, domain: DOMAIN, approved_by: asha.workosUserId },
    { org_id: design.orgId, domain: DOMAIN, approved_by: carol.workosUserId },
  ]).execute();
  const found = await orgMatches(db, `Tom@${DOMAIN.toUpperCase()}`, true);
  // Every OPEN workspace of each org, largest org first, its default first.
  assert.deepEqual(found.map(m => [m.name, m.workspaceId === acme.workspaceId, m.isDefault]),
    [['Acme', true, true], ['Acme', false, false], ['Acme Design', false, true]]);
  assert.ok(!found.some(m => m.workspaceId === leadership.workspaceId), 'invite-only is never offered');
});

test('an unverified mailbox, or a public domain, never matches', opts, async () => {
  assert.deepEqual(await orgMatches(db, eve.email, false), []);
  assert.deepEqual(await orgMatches(db, dev.email, true), []);
});

test('a domain join: WorkOS first, mirror at once, open workspaces only', opts, async () => {
  assert.equal(await joinWorkspace(db, tom, leadership.workspaceId, 'tom'), 'not_invited',
    'a domain opens the org\'s open workspaces, never an invite-only one');
  assert.equal(await joinWorkspace(db, eve, acme.workspaceId, 'eve'), 'not_invited', 'unverified');

  const joined = await joinWorkspace(db, tom, acme.workspaceId, 'tom');
  assert.equal(typeof joined, 'object');
  if (typeof joined !== 'object') return;
  const actor = await db.selectFrom('actors').select('provisioned_by').where('id', '=', joined.actorId).executeTakeFirstOrThrow();
  assert.equal(actor.provisioned_by, 'domain');
  assert.ok(W.added.includes(`${tom.workosUserId}@${await workosOrgOf(acme.orgId)}`), 'added to the WorkOS org');
  const mirror = await db.selectFrom('workos_memberships').select('status')
    .where('workos_user_id', '=', tom.workosUserId).executeTakeFirst();
  assert.equal(mirror?.status, 'active', 'visible without waiting for the poller');
});

// ── who governs the org (spike checks 5.1–5.4) ─────────────────────────────
test('org admin is owner or admin of the DEFAULT workspace, and nothing else', opts, async () => {
  assert.equal(await canOrg(db, asha.workosUserId, 'create_workspace', acme.orgId), true);
  assert.equal(await canOrg(db, tom.workosUserId, 'create_workspace', acme.orgId), false);

  // Ravi owns nothing in the default. Making him admin of a SIBLING workspace
  // gives him nothing at the org...
  const raviPayments = await db.selectFrom('actors').select('id')
    .where('workspace_id', '=', payments.workspaceId).where('identity_id', '=', ravi.workosUserId).executeTakeFirstOrThrow();
  await db.updateTable('memberships').set({ role: 'admin' })
    .where('actor_id', '=', raviPayments.id).where('scope_type', '=', 'workspace').execute();
  assert.equal(await canOrg(db, ravi.workosUserId, 'manage_domains', acme.orgId), false);

  // ...admin of the default makes Tom an org admin.
  const tomDefault = await db.selectFrom('actors').select('id')
    .where('workspace_id', '=', acme.workspaceId).where('identity_id', '=', tom.workosUserId).executeTakeFirstOrThrow();
  await db.updateTable('memberships').set({ role: 'admin' })
    .where('actor_id', '=', tomDefault.id).where('scope_type', '=', 'workspace').execute();
  assert.equal(await canOrg(db, tom.workosUserId, 'manage_domains', acme.orgId), true);
  // And being admin of one org is nothing in another.
  assert.equal(await canOrg(db, tom.workosUserId, 'manage_domains', orgs[1]!), false);
});

// ── domains verified in WorkOS (§11) ───────────────────────────────────────
test('a domain verified in WorkOS: copied in, labelled "company", exclusive, and WorkOS\'s to remove', opts, async () => {
  const workosOrg = await workosOrgOf(acme.orgId);
  W.orgDomains[workosOrg] = [{ domain: DOMAIN, state: 'verified' }, { domain: `pending-${tag}.test`, state: 'pending' }];

  // Uma signs in; WorkOS has already added her to the org by her domain.
  const uma = person('uma');
  W.members.push({ user_id: uma.workosUserId, organization_id: workosOrg });
  const joins = await pendingJoins(db, uma);
  assert.ok(joins.length > 0 && joins.every(j => j.reason === 'company'), 'she arrived by domain, and is told so');

  const rows = await db.selectFrom('organization_domains').select(['domain', 'source', 'verified_at'])
    .where('org_id', '=', acme.orgId).execute();
  assert.deepEqual(rows.map(r => [r.domain, r.source, r.verified_at !== null]), [[DOMAIN, 'workos', true]],
    'the app approval of the same domain was upgraded; the pending one was not copied');

  // Verified is exclusive: Acme Design's in-app approval of the same domain no
  // longer matches anyone.
  const found = await orgMatches(db, `newbie@${DOMAIN}`, true);
  assert.ok(found.length > 0 && found.every(m => m.orgId === acme.orgId));

  // Removed in WorkOS: our copy goes on the next sync.
  W.orgDomains[workosOrg] = [];
  await syncWorkosDomains(db, [workosOrg]);
  const after = await db.selectFrom('organization_domains').select('domain').where('org_id', '=', acme.orgId).execute();
  assert.deepEqual(after, []);
});

test('a newcomer finds a domain verified in WorkOS AFTER they signed in, without signing in again', opts, async () => {
  const workosOrg = await workosOrgOf(acme.orgId);
  // Verified in WorkOS just now; nobody has synced it yet.
  W.orgDomains[workosOrg] = [{ domain: DOMAIN, state: 'verified' }];
  assert.deepEqual(await orgMatches(db, `late@${DOMAIN}`, true)
    .then(ms => ms.filter(m => m.orgId === acme.orgId && m.isDefault)).then(ms => ms.length), 0,
    'our copy does not know yet');
  await syncWorkosDomainsFor(db, `late@${DOMAIN}`);   // what "check again" runs
  const found = await orgMatches(db, `late@${DOMAIN}`, true);
  assert.ok(found.some(m => m.orgId === acme.orgId && m.isDefault));
  // A public domain is never even asked about.
  await syncWorkosDomainsFor(db, 'someone@gmail.com');
  W.orgDomains[workosOrg] = [];
  await syncWorkosDomains(db, [workosOrg]);
});
