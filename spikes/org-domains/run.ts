// Spike: does docs/ORG-DOMAINS.md hold up against the real server code?
//
// Runs the REAL server functions — provisioning, joining, the WorkOS poller,
// sync catch-up and welcome, /auth/refresh — against a throwaway Postgres
// database built from the real migrations plus the proposed 034. WorkOS is the
// only fake: `fetch` is replaced with an in-memory WorkOS that also emits the
// events the poller reads.
//
//   node --env-file=.env spikes/org-domains/run.ts
//
// Each check reports PASS (the proposal holds), FINDING (the proposal as written
// is wrong or incomplete) or FAIL (the spike itself broke). The database is
// dropped and recreated at the start of every run and left behind afterwards
// for inspection.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { deepStrictEqual } from 'node:assert/strict';

const serverRequire = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const load = async (name: string) => (await import(pathToFileURL(serverRequire.resolve(name)).href)).default;
const pg = await load('pg');
const Fastify = await load('fastify');

// ── throwaway database ──────────────────────────────────────────────────────
const base = process.env['DATABASE_URL'];
if (!base) throw new Error('DATABASE_URL not set — run with --env-file=.env');
const SPIKE_DB = 'relayed_spike_org_domains';
const url = new URL(base); url.pathname = `/${SPIKE_DB}`;
{
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SPIKE_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SPIKE_DB}`);
  await admin.end();
}
process.env['DATABASE_URL'] = url.toString();
process.env['WORKOS_API_KEY'] ??= 'sk_spike';
delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

// ── fake WorkOS ─────────────────────────────────────────────────────────────
interface WMember { id: string; user_id: string; organization_id: string; status: string }
const W = {
  seq: 0,
  orgs: new Map<string, string>(),
  members: [] as WMember[],
  users: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
};
const next = (p: string) => `${p}_${String(++W.seq).padStart(6, '0')}`;
function event(kind: string, m: WMember) {
  W.events.push({ id: next('evt'), event: kind, created_at: new Date().toISOString(),
    data: { id: m.id, user_id: m.user_id, organization_id: m.organization_id, status: m.status } });
}
function wAdd(orgId: string, userId: string): WMember {
  const m = { id: next('om'), user_id: userId, organization_id: orgId, status: 'active' };
  W.members.push(m); event('organization_membership.created', m); return m;
}
function wRemove(orgId: string, userId: string) {
  const m = W.members.find(x => x.organization_id === orgId && x.user_id === userId && x.status === 'active');
  if (!m) throw new Error(`no WorkOS membership ${userId} in ${orgId}`);
  m.status = 'inactive'; event('organization_membership.deleted', m);
}
function user(id: string, email: string, verified = true) {
  W.users.set(id, { id, email, email_verified: verified, first_name: id.slice(2), last_name: null,
                    profile_picture_url: null });
}
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const u = new URL(String(input));
  if (u.host !== 'api.workos.com') throw new Error(`spike: unexpected fetch ${u}`);
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const json = (x: unknown, status = 200) =>
    new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
  if (method === 'POST' && u.pathname === '/organizations') {
    const id = next('org_w'); W.orgs.set(id, body.name); return json({ id, name: body.name });
  }
  if (method === 'POST' && u.pathname === '/user_management/organization_memberships') {
    return json(wAdd(body.organization_id, body.user_id));
  }
  if (method === 'GET' && u.pathname === '/user_management/organization_memberships') {
    const uid = u.searchParams.get('user_id');
    return json({ data: W.members.filter(m => m.user_id === uid && m.status === 'active') });
  }
  if (method === 'GET' && u.pathname.startsWith('/user_management/users/')) {
    const found = W.users.get(decodeURIComponent(u.pathname.split('/').pop()!));
    return found ? json(found) : json({ message: 'not found' }, 404);
  }
  if (method === 'GET' && u.pathname === '/events') {
    const after = u.searchParams.get('after');
    const limit = Number(u.searchParams.get('limit') ?? 100);
    const from = after ? W.events.findIndex(e => e['id'] === after) + 1 : 0;
    const data = W.events.slice(from, from + limit);
    return json({ data, list_metadata: { after: (data.at(-1)?.['id'] as string) ?? null } });
  }
  throw new Error(`spike: unhandled WorkOS call ${method} ${u.pathname}`);
}) as typeof fetch;

// ── the real server code, loaded against the spike database ────────────────
const S = '../../apps/server/src';
const { migrate } = await import(`${S}/db/migrate.ts`);
await migrate(url.toString());

const { db, pool } = await import(`${S}/db/client.ts`);
const { ulid } = await import(`${S}/db/ulid.ts`);
const { createWorkspace, resolveMemberships } = await import(`${S}/provisioning/provision.ts`);
const { pendingJoins, joinWorkspace } = await import(`${S}/provisioning/join.ts`);
const { seedWorkspace, joinPublicSpaces } = await import(`${S}/provisioning/onboard.ts`);
const { send } = await import(`${S}/sync/ops.ts`);
const { catchup, welcome } = await import(`${S}/sync/feed.ts`);
const { recordActor } = await import(`${S}/sync/directory.ts`);
const { pollOnce } = await import(`${S}/workos/poller.ts`);
const { loadGrants } = await import(`${S}/authz/can.ts`);
const { fetchProfile } = await import(`${S}/auth/workos-profile.ts`);
const { authRoutes } = await import(`${S}/auth/routes.ts`);
const tokens = await import(`${S}/auth/tokens.ts`);

const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await q(text, params))[0];

// ── harness ─────────────────────────────────────────────────────────────────
type Verdict = 'PASS' | 'FINDING' | 'FAIL';
const results: { id: string; title: string; verdict: Verdict; detail: string }[] = [];
async function check(id: string, title: string, fn: () => Promise<[Verdict, string]>) {
  try {
    const [verdict, detail] = await fn();
    results.push({ id, title, verdict, detail });
  } catch (e) {
    results.push({ id, title, verdict: 'FAIL', detail: (e as Error).stack?.split('\n').slice(0, 3).join(' | ') ?? String(e) });
  }
}
/** Run statements in a transaction that is always rolled back. */
async function dryRun<T>(fn: (c: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number }> }) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); return await fn(c); }
  finally { await c.query('ROLLBACK'); c.release(); }
}

// ── pure pieces of the proposal (§4) ────────────────────────────────────────
const PUBLIC = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com']);
const domainOf = (email: string) => email.trim().toLowerCase().split('@')[1] ?? '';
const mayApprove = (adminEmail: string, adminVerified: boolean, domain: string) =>
  adminVerified && !PUBLIC.has(domain) && domainOf(adminEmail) === domain;

// ── seed: today's world, through today's code ───────────────────────────────
const who = (id: string, email: string) => ({ workosUserId: id, email, displayName: id.slice(2), avatarUrl: null });
for (const [id, email, v] of [
  ['u_asha', 'asha@acme.com', true], ['u_ravi', 'ravi@acme.com', true], ['u_carol', 'carol@acme.com', true],
  ['u_sam', 'sam@acme.com', true], ['u_dan', 'dan@acme.com', true], ['u_tom', 'tom@acme.com', true],
  ['u_eve', 'eve@acme.com', false], ['u_dev', 'dev@gmail.com', true], ['u_meera', 'meera@gmail.com', true],
] as const) user(id, email, v);

const acme = await createWorkspace(db, who('u_asha', 'asha@acme.com'), { workspaceName: 'Acme', handle: 'asha' });
await seedWorkspace(db, acme.workspaceId, acme.actorId);
const acmeW = (await one('SELECT workos_org_id FROM organizations WHERE id = $1', [acme.orgId])).workos_org_id;
wAdd(acmeW, 'u_ravi');
const ravi = await joinWorkspace(db, who('u_ravi', 'ravi@acme.com'), acme.workspaceId, 'ravi');
if (typeof ravi !== 'object') throw new Error(`seed: ravi join ${ravi}`);
await joinPublicSpaces(db, acme.workspaceId, ravi.actorId);

const design = await createWorkspace(db, who('u_carol', 'carol@acme.com'), { workspaceName: 'Acme Design', handle: 'carol' });
await seedWorkspace(db, design.workspaceId, design.actorId);
const designW = (await one('SELECT workos_org_id FROM organizations WHERE id = $1', [design.orgId])).workos_org_id;

const sams = await createWorkspace(db, who('u_sam', 'sam@acme.com'), { workspaceName: 'Acme', handle: 'sam' });
await seedWorkspace(db, sams.workspaceId, sams.actorId);
const samsW = (await one('SELECT workos_org_id FROM organizations WHERE id = $1', [sams.orgId])).workos_org_id;

await createWorkspace(db, who('u_meera', 'meera@gmail.com'), { workspaceName: "Meera's Studio", handle: 'meera' });

async function general(workspaceId: string) {
  return one(`SELECT s.id AS space_id, c.id AS chat_id FROM spaces s JOIN chats c ON c.space_id = s.id
               WHERE s.workspace_id = $1 AND s.kind = 'channel' ORDER BY s.created_at LIMIT 1`, [workspaceId]);
}
const acmeGeneral = await general(acme.workspaceId);
const designGeneral = await general(design.workspaceId);
for (const [actorId, chatId, body] of [
  [acme.actorId, acmeGeneral.chat_id, 'hello acme'], [ravi.actorId, acmeGeneral.chat_id, 'hi asha'],
  [design.actorId, designGeneral.chat_id, 'design review at 3'], [design.actorId, designGeneral.chat_id, 'moodboard attached'],
]) await send(db, { opId: ulid('op'), chatId, actorId, messageId: ulid('msg'), body });
await pollOnce();   // mirror everything WorkOS has said so far

// ── 1. the proposed migration against today's data ─────────────────────────
await check('1.1', 'The actor_prov rewrite in §12, exactly as written, against real data', async () => dryRun(async c => {
  await c.query(`ALTER TABLE actors DROP CONSTRAINT actor_prov`);
  try {
    await c.query(`ALTER TABLE actors ADD CONSTRAINT actor_prov
      CHECK (provisioned_by IN ('self_signup','invite','domain','sso_jit','scim','api'))`);
    return ['PASS', 'applies'] as [Verdict, string];
  } catch (e) {
    return ['FINDING', `${(e as Error).message}. Every workspace has system agents with provisioned_by = 'system' (022_system_agents.sql); §12 was written from 001 and drops it. 034_org_domains.sql here carries the fix.`] as [Verdict, string];
  }
}));

await check('1.2', 'Proposed 034 (corrected) applies on top of 001–033 with real data present', async () => {
  await pool.query(readFileSync(new URL('./034_org_domains.sql', import.meta.url), 'utf8'));
  return ['PASS', 'applied cleanly, backfill included'];
});

await check('1.3', 'Backfill: default workspace, org_open, founder admin, joiner member', async () => {
  const orgs = await q('SELECT o.id, o.default_workspace_id, w.join_policy FROM organizations o JOIN workspaces w ON w.id = o.default_workspace_id');
  const roles = await q('SELECT org_id, identity_id, role FROM org_roles ORDER BY identity_id');
  const r = Object.fromEntries(roles.map(x => [`${x.org_id === acme.orgId ? 'acme' : x.org_id}:${x.identity_id}`, x.role]));
  const ok = orgs.length === 4 && orgs.every(o => o.join_policy === 'org_open')
    && r[`acme:u_asha`] === 'admin' && r[`acme:u_ravi`] === 'member' && roles.length === 5;
  return [ok ? 'PASS' : 'FINDING', `${orgs.length} orgs defaulted; ${roles.length} org_roles rows; agents excluded`];
});

await check('1.4', 'provisioned_by = domain accepted after 034', async () => dryRun(async c => {
  await c.query(`INSERT INTO actors (id, org_id, workspace_id, type, handle, display_name, identity_kind,
                 identity_id, provisioned_by) VALUES ($1,$2,$3,'human','probe','Probe','workos_user','u_probe','domain')`,
                [ulid('act'), acme.orgId, acme.workspaceId]);
  return ['PASS', 'constraint widened'] as [Verdict, string];
}));

// ── 2. several workspaces in one org, through today's code ─────────────────
const leadership = { workspaceId: ulid('wsp'), actorId: ulid('act') };
await db.transaction().execute(async (tx: any) => {
  // What §7.1's createWorkspaceInOrg would do: no WorkOS call, same rows as createWorkspace.
  await tx.insertInto('workspaces').values({ id: leadership.workspaceId, org_id: acme.orgId,
    name: 'Acme Leadership', slug: 'acme-leadership' }).execute();
  await tx.insertInto('actors').values({ id: leadership.actorId, org_id: acme.orgId,
    workspace_id: leadership.workspaceId, type: 'human', handle: 'asha', display_name: 'asha',
    avatar_url: null, identity_kind: 'workos_user', identity_id: 'u_asha', owner_actor_id: null,
    provisioned_by: 'self_signup', state: 'active' }).execute();
  await recordActor(tx, 'actor.created', { id: leadership.actorId, workspaceId: leadership.workspaceId,
    type: 'human', handle: 'asha', displayName: 'asha', avatarUrl: null, ownerActorId: null, state: 'active' });
  await tx.insertInto('memberships').values({ scope_type: 'workspace', scope_id: leadership.workspaceId,
    actor_id: leadership.actorId, role: 'owner', left_at: null }).execute();
});
await q(`UPDATE workspaces SET join_policy = 'invite_only' WHERE id = $1`, [leadership.workspaceId]);

await check('2.1', 'A second workspace in an org: resolveMemberships returns both, streams stay separate', async () => {
  const mine = await resolveMemberships(db, 'u_asha');
  const inAcme = mine.filter((m: any) => m.orgId === acme.orgId).map((m: any) => m.workspaceId).sort();
  const wA = await welcome(db, acme.workspaceId, acme.actorId);
  const wL = await welcome(db, leadership.workspaceId, leadership.actorId);
  const leak = JSON.stringify(wL).includes(acmeGeneral.chat_id);
  const ok = inAcme.length === 2 && !leak && JSON.stringify(wA).includes(acmeGeneral.chat_id);
  return [ok ? 'PASS' : 'FINDING', `asha holds ${inAcme.length} workspaces in Acme; Leadership welcome carries none of Acme's chats`];
});

await check('2.2', 'pendingJoins hides an invite_only workspace from an org member', async () => {
  const joins = await pendingJoins(db, who('u_ravi', 'ravi@acme.com'));
  const seen = joins.some((j: any) => j.workspaceId === leadership.workspaceId);
  return seen
    ? ['FINDING', 'pendingJoins lists EVERY workspace of every WorkOS org the person is in — Ravi is offered Acme Leadership (invite_only). It has no join_policy filter (join.ts:61).']
    : ['PASS', 'not offered'];
});

await check('2.3', 'joinWorkspace refuses an invite_only workspace to an org member', async () => {
  const r = await joinWorkspace(db, who('u_ravi', 'ravi@acme.com'), leadership.workspaceId, 'ravi');
  return typeof r === 'object'
    ? ['FINDING', 'Ravi joined Acme Leadership. joinWorkspace admits anyone WorkOS lists in the org (join.ts:112); with several workspaces per org that is every workspace, invite_only included.']
    : ['PASS', `refused: ${r}`];
});

await check('2.4', 'An invitation says which workspace it is for', async () => {
  wAdd(acmeW, 'u_dev');   // Dev accepts an invitation Asha sent from Acme Leadership
  const joins = await pendingJoins(db, who('u_dev', 'dev@gmail.com'));
  const names = joins.map((j: any) => j.name).sort();
  return names.length > 1
    ? ['FINDING', `WorkOS invitations are org-level, so Dev is offered ${names.join(' + ')}. Nothing records which workspace the invite came from; a workspace_invitations row (workos_invitation_id → workspace_id) is needed.`]
    : ['PASS', names.join(', ')];
});

// ── 3. approved domains (§4) ────────────────────────────────────────────────
await check('3.1', 'Two orgs may approve the same domain; sign-in finds both', async () => {
  await q(`INSERT INTO organization_domains (org_id, domain, approved_by) VALUES ($1,'acme.com','u_asha'), ($2,'acme.com','u_carol')`,
          [acme.orgId, design.orgId]);
  const found = await q(`SELECT o.name FROM organization_domains d JOIN organizations o ON o.id = d.org_id
                          WHERE d.domain = $1 ORDER BY o.name`, [domainOf(' Tom@ACME.com ')]);
  return [found.length === 2 ? 'PASS' : 'FINDING', `tom@ACME.com → ${found.map(f => f.name).join(', ')}`];
});

await check('3.2', 'Verification is exclusive; approval is not', async () => {
  await q(`UPDATE organization_domains SET verified_at = now() WHERE org_id = $1 AND domain = 'acme.com'`, [acme.orgId]);
  let blocked = false;
  try { await q(`UPDATE organization_domains SET verified_at = now() WHERE org_id = $1 AND domain = 'acme.com'`, [design.orgId]); }
  catch (e) { blocked = /organization_domains_verified/.test((e as Error).message); }
  await q(`UPDATE organization_domains SET verified_at = NULL`);
  return [blocked ? 'PASS' : 'FINDING', blocked ? 'second verify refused by the partial unique index' : 'second verify allowed'];
});

await check('3.3', 'Approval rules: own domain only, never public, case-insensitive', async () => {
  const cases: [string, boolean, string, boolean][] = [
    ['asha@acme.com', true, 'acme.com', true], ['meera@gmail.com', true, 'acme.com', false],
    ['meera@gmail.com', true, 'gmail.com', false], ['eve@acme.com', false, 'acme.com', false],
    ['asha@acme.com', true, 'mail.acme.com', false], ['Asha@ACME.com', true, 'acme.com', true],
  ];
  const bad = cases.filter(([e, v, d, want]) => mayApprove(e, v, d) !== want);
  return [bad.length === 0 ? 'PASS' : 'FINDING', `${cases.length} cases`];
});

await check('3.4', 'fetchProfile exposes email_verified', async () => {
  const p = await fetchProfile('u_eve');
  return 'email_verified' in p || 'emailVerified' in p
    ? ['PASS', 'present']
    : ['FINDING', 'fetchProfile drops email_verified (workos-profile.ts:24). An unverified eve@acme.com is indistinguishable from a verified one — §4.1 rule 1 needs this field added. Expected; listed in §15 step 4.'];
});

// ── 4. domain join, through today's join path ──────────────────────────────
await check('4.1', 'Domain join = WorkOS addMember, then the existing joinWorkspace', async () => {
  const before = await one('SELECT count(*)::int AS n FROM workos_memberships WHERE workos_user_id = $1', ['u_tom']);
  const res = await fetch(`https://api.workos.com/user_management/organization_memberships`,
    { method: 'POST', body: JSON.stringify({ organization_id: acmeW, user_id: 'u_tom' }) });
  if (!res.ok) throw new Error('addMember failed');
  const mirrorBeforePoll = await one('SELECT count(*)::int AS n FROM workos_memberships WHERE workos_user_id = $1', ['u_tom']);
  const joined = await joinWorkspace(db, who('u_tom', 'tom@acme.com'), acme.workspaceId, 'tom');
  await pollOnce();
  const mirrorAfter = await one('SELECT count(*)::int AS n FROM workos_memberships WHERE workos_user_id = $1', ['u_tom']);
  const ok = typeof joined === 'object';
  return [ok && mirrorBeforePoll.n === 0 ? 'FINDING' : ok ? 'PASS' : 'FAIL',
    `joinWorkspace admitted Tom unchanged (${ok}). But the mirror had ${before.n}→${mirrorBeforePoll.n} rows until the poller ran (→${mirrorAfter.n}): anything that reads org membership from workos_memberships — Browse workspaces, /auth/refresh pending_joins — is blind to a domain joiner for up to one poll interval (30 s). Write the mirror row when we call addMember.`];
});

// ── 5. do we need org_roles? ────────────────────────────────────────────────
const isAdminA = async (orgId: string, uid: string) =>
  (await one(`SELECT role FROM org_roles WHERE org_id = $1 AND identity_id = $2 AND left_at IS NULL`, [orgId, uid]))?.role === 'admin';
const isAdminB = async (orgId: string, uid: string) => !!(await one(
  `SELECT 1 FROM organizations o
     JOIN actors a ON a.workspace_id = o.default_workspace_id AND a.identity_id = $2 AND a.state = 'active'
     JOIN memberships m ON m.actor_id = a.id AND m.scope_type = 'workspace' AND m.scope_id = a.workspace_id
                       AND m.left_at IS NULL AND m.role IN ('owner','admin')
    WHERE o.id = $1`, [orgId, uid]));

await check('5.1', 'Option C — an org grant in `memberships`, keyed by actor', async () => {
  await q(`ALTER TABLE memberships DROP CONSTRAINT membership_scope`);
  await q(`ALTER TABLE memberships ADD CONSTRAINT membership_scope CHECK (scope_type IN ('workspace','space','chat','organization'))`);
  await q(`INSERT INTO memberships (scope_type, scope_id, actor_id, role) VALUES ('organization', $1, $2, 'admin')`, [acme.orgId, acme.actorId]);
  const fromDefault = [...(await loadGrants(db, acme.actorId)).keys()].some(k => String(k).includes(acme.orgId));
  const fromLeadership = [...(await loadGrants(db, leadership.actorId)).keys()].some(k => String(k).includes(acme.orgId));
  await q(`DELETE FROM memberships WHERE scope_type = 'organization'`);
  await q(`ALTER TABLE memberships DROP CONSTRAINT membership_scope`);
  await q(`ALTER TABLE memberships ADD CONSTRAINT membership_scope CHECK (scope_type IN ('workspace','space','chat'))`);
  return fromDefault && !fromLeadership
    ? ['PASS', 'Ruled out, as the doc says: Asha is org admin while in Acme, and not while in Acme Leadership — one person, two actors, the grant sits on one of them.']
    : ['FINDING', `default=${fromDefault} leadership=${fromLeadership}`];
});

await check('5.2', 'Option A (org_roles) vs B (admin of the default workspace) agree on every scenario', async () => {
  const scenarios = [['acme', acme.orgId, 'u_asha', true], ['acme', acme.orgId, 'u_ravi', false],
                     ['acme', acme.orgId, 'u_tom', false], ['design', design.orgId, 'u_carol', true]] as const;
  const diffs = [];
  for (const [, org, uid, want] of scenarios) {
    const a = await isAdminA(org, uid), b = await isAdminB(org, uid);
    if (a !== want || b !== want) diffs.push(`${uid}: A=${a} B=${b} want=${want}`);
  }
  return diffs.length
    ? ['FINDING', `disagree: ${diffs.join('; ')}${diffs.some(d => d.startsWith('u_tom')) ? ' — org_roles has no row for Tom: the domain-join path must remember to write one' : ''}`]
    : ['PASS', `${scenarios.length} scenarios, identical answers`];
});

await check('5.3', 'Org MEMBERSHIP already exists twice — WorkOS mirror and org_roles', async () => {
  const mirror = (await q(`SELECT workos_user_id AS u FROM workos_memberships WHERE workos_org_id = $1 AND status = 'active' ORDER BY 1`, [acmeW])).map(r => r.u);
  const roles = (await q(`SELECT identity_id AS u FROM org_roles WHERE org_id = $1 AND left_at IS NULL ORDER BY 1`, [acme.orgId])).map(r => r.u);
  return ['FINDING', `mirror: [${mirror.join(', ')}]  org_roles: [${roles.join(', ')}]. Already drifted after two joins through today's code. The mirror is the documented authority on who is ADMITTED (004_workos_events.sql); org_roles "member" rows duplicate it.`];
});

await check('5.4', 'Option B always has an admin; A needs a guard', async () => {
  const ownerless = await one(`SELECT count(*)::int AS n FROM organizations o WHERE NOT EXISTS (
      SELECT 1 FROM memberships m WHERE m.scope_type = 'workspace' AND m.scope_id = o.default_workspace_id
       AND m.role = 'owner' AND m.left_at IS NULL)`);
  return [ownerless.n === 0 ? 'PASS' : 'FINDING',
    `orgs whose default workspace has no owner: ${ownerless.n}. membership_one_owner already guarantees one owner per workspace, so B inherits "an org always has an admin" for free; A needs its own last-admin check.`];
});

// ── 6. claims (§11.3) and what sync sees ───────────────────────────────────
await check('6.1', 'Every table with a foreign key to organizations is moved by a claim', async () => {
  const fks = await q(`SELECT c.conrelid::regclass::text AS tbl, a.attname AS col,
                              CASE c.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'r' THEN 'RESTRICT' WHEN 'n' THEN 'SET NULL' ELSE c.confdeltype::text END AS on_delete
                         FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
                        WHERE c.contype = 'f' AND c.confrelid = 'organizations'::regclass ORDER BY 1`);
  const doc = new Set(['workspaces', 'actors', 'org_roles', 'organization_domains']);
  const missed = fks.filter(f => !doc.has(f.tbl));
  return [missed.length ? 'FINDING' : 'PASS',
    `FKs to organizations: ${fks.map(f => `${f.tbl}.${f.col} ${f.on_delete}`).join(', ')}. §11.3 names workspaces and actors; it misses ${missed.map(f => f.tbl).join(', ') || 'nothing'}.`];
});

await check('6.2', 'The claim as §11.3 is written (move workspaces + actors, delete old org) loses nothing', async () => dryRun(async c => {
  const count = async () => (await c.query(`SELECT
      (SELECT count(*) FROM spaces WHERE workspace_id = $1)::int AS spaces,
      (SELECT count(*) FROM messages m JOIN chats ch ON ch.id = m.chat_id JOIN spaces s ON s.id = ch.space_id WHERE s.workspace_id = $1)::int AS messages`,
      [design.workspaceId])).rows[0];
  const before = await count();
  await c.query(`UPDATE workspaces SET org_id = $1 WHERE id = $2`, [acme.orgId, design.workspaceId]);
  await c.query(`UPDATE actors SET org_id = $1 WHERE workspace_id = $2`, [acme.orgId, design.workspaceId]);
  try { await c.query(`DELETE FROM organizations WHERE id = $1`, [design.orgId]); }
  catch (e) { return ['FINDING', `delete failed: ${(e as Error).message}`] as [Verdict, string]; }
  const after = await count();
  return (after.spaces < before.spaces
    ? ['FINDING', `SILENT DATA LOSS: spaces ${before.spaces}→${after.spaces}, messages ${before.messages}→${after.messages}. spaces.org_id is ON DELETE CASCADE and the doc does not move it.`]
    : ['PASS', 'nothing lost']) as [Verdict, string];
}));

await check('6.3', 'Claiming an org whose workspace slug is already taken in the target org', async () => dryRun(async c => {
  try {
    await c.query(`UPDATE workspaces SET org_id = $1 WHERE id = $2`, [acme.orgId, sams.workspaceId]);
    return ['PASS', 'no clash'] as [Verdict, string];
  } catch (e) {
    return ['FINDING', `Sam's "Acme" cannot move into Acme: ${(e as Error).message}. UNIQUE (org_id, slug) — a claim must rename the slug.`] as [Verdict, string];
  }
}));

await check('6.4', 'WorkOS first, then the database (§11.3 as written) — does the poller deactivate the person?', async () => {
  wAdd(acmeW, 'u_sam');
  wRemove(samsW, 'u_sam');
  await pollOnce();   // the poller runs before our transaction does
  const state = (await one(`SELECT state FROM actors WHERE id = $1`, [sams.actorId])).state;
  return state === 'deactivated'
    ? ['FINDING', `Sam is ${state}. Removing him from the old WorkOS org emits organization_membership.deleted, and the poller's deactivate() (poller.ts:124) matches his actor through actors.org_id — still the OLD org until our transaction runs. Order must be: addMember(new) → our transaction → removeMember(old).`]
    : ['PASS', `sam is ${state}`];
});

// Snapshot Carol's view before the real claim.
const snap = async () => ({
  welcome: await welcome(db, design.workspaceId, design.actorId),
  wsStream: await catchup(db, design.actorId, { kind: 'workspace', id: design.workspaceId }, 0),
  spaceStream: await catchup(db, design.actorId, { kind: 'space', id: designGeneral.space_id }, 0),
  chatStream: await catchup(db, design.actorId, { kind: 'chat', id: designGeneral.chat_id }, 0),
});
await q(`UPDATE organizations SET avatar_url = 'https://img/design.png' WHERE id = $1`, [design.orgId]);
await q(`UPDATE organizations SET avatar_url = 'https://img/acme.png' WHERE id = $1`, [acme.orgId]);
const before = await snap();
const beforeMembership = (await resolveMemberships(db, 'u_carol')).find((m: any) => m.workspaceId === design.workspaceId);

const refresh = tokens.newRefreshToken();
await db.insertInto('sessions').values({ id: ulid('ses'), actor_id: design.actorId, device_id: 'dev_spike',
  refresh_hash: tokens.hashRefreshToken(refresh), expires_at: new Date(Date.now() + 86_400_000), revoked_at: null }).execute();
const oldAccess = await tokens.signAccessToken({ actorId: design.actorId, orgId: design.orgId,
  workspaceId: design.workspaceId, deviceId: 'dev_spike', sessionId: 'ses_old' });

await check('6.5', 'Corrected claim: addMember → one transaction moving every org_id → removeMember', async () => {
  wAdd(acmeW, 'u_carol');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`UPDATE workspaces SET org_id = $1 WHERE org_id = $2`, [acme.orgId, design.orgId]);
    await c.query(`UPDATE actors     SET org_id = $1 WHERE org_id = $2`, [acme.orgId, design.orgId]);
    await c.query(`UPDATE spaces     SET org_id = $1 WHERE org_id = $2`, [acme.orgId, design.orgId]);
    await c.query(`INSERT INTO org_roles (org_id, identity_kind, identity_id, role)
                   SELECT $1, identity_kind, identity_id, 'member' FROM org_roles WHERE org_id = $2
                   ON CONFLICT DO NOTHING`, [acme.orgId, design.orgId]);
    await c.query(`DELETE FROM organizations WHERE id = $1`, [design.orgId]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  wRemove(designW, 'u_carol');
  await pollOnce();
  const carol = (await one(`SELECT state, org_id FROM actors WHERE id = $1`, [design.actorId]));
  const drift = await one(`SELECT
      (SELECT count(*) FROM actors a JOIN workspaces w ON w.id = a.workspace_id WHERE a.org_id <> w.org_id)::int +
      (SELECT count(*) FROM spaces s JOIN workspaces w ON w.id = s.workspace_id WHERE s.org_id <> w.org_id)::int AS n`);
  const ok = carol.state === 'active' && carol.org_id === acme.orgId && drift.n === 0;
  return [ok ? 'PASS' : 'FINDING', `Carol ${carol.state} in Acme; rows whose org_id disagrees with their workspace: ${drift.n}`];
});

await check('6.6', 'Sync after a claim: welcome and catch-up on every stream are byte-identical', async () => {
  const after = await snap();
  const diffs: string[] = [];
  for (const k of Object.keys(before) as (keyof typeof before)[]) {
    try { deepStrictEqual(after[k], before[k]); } catch { diffs.push(k); }
  }
  const msgs = (after.chatStream as any).events?.length ?? 0;
  return [diffs.length ? 'FINDING' : 'PASS',
    diffs.length ? `changed: ${diffs.join(', ')}` : `workspace, space and chat streams unchanged (${msgs} chat events); workspace_id never moved, and no replica row carries org_id (workspace.ts migration: "No org_id")`];
});

await check('6.7', '/auth/refresh after a claim issues a token for the new org, same workspace', async () => {
  const app = Fastify(); await authRoutes(app); await app.ready();
  const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token: refresh } });
  await app.close();
  if (res.statusCode !== 200) return ['FINDING', `refresh → ${res.statusCode} ${res.body}`];
  const body = res.json();
  const claims = await tokens.verifyAccessToken(body.access_token);
  const wire = body.memberships.find((m: any) => m.workspace_id === design.workspaceId);
  const ok = claims.orgId === acme.orgId && claims.workspaceId === design.workspaceId && wire?.org_id === acme.orgId;
  return [ok ? 'PASS' : 'FINDING', `token org=${claims.orgId === acme.orgId ? 'Acme' : claims.orgId}, workspace unchanged; membership wire org_id updated — account.db upserts org_id on conflict (storage.ts:528)`];
});

await check('6.8', 'A pre-claim access token still verifies, naming a deleted org', async () => {
  const claims = await tokens.verifyAccessToken(oldAccess);
  const exists = await one(`SELECT 1 FROM organizations WHERE id = $1`, [claims.orgId]);
  return ['PASS', `valid until expiry with org=${exists ? 'live' : 'DELETED'} org. Harmless today: Caller.orgId (caller.ts:28) has no reader and the socket authorises streams on workspaceId alone (socket.ts:345). §11.7's rule is what keeps it harmless.`];
});

await check('6.9', 'The claimed workspace keeps its own icon', async () => {
  const after = (await resolveMemberships(db, 'u_carol')).find((m: any) => m.workspaceId === design.workspaceId);
  return beforeMembership.workspaceAvatarUrl === after.workspaceAvatarUrl
    ? ['PASS', 'unchanged']
    : ['FINDING', `icon changed ${beforeMembership.workspaceAvatarUrl} → ${after.workspaceAvatarUrl}. A workspace with no image of its own shows its org's (provision.ts:110); a claim must copy the old org's avatar onto such workspaces first.`];
});

// ── 7. removal from an org ─────────────────────────────────────────────────
await check('7.1', 'Removing someone from the org deactivates them in every workspace of it', async () => {
  wRemove(acmeW, 'u_ravi');
  await pollOnce();
  const states = await q(`SELECT w.name, a.state FROM actors a JOIN workspaces w ON w.id = a.workspace_id
                           WHERE a.identity_id = 'u_ravi' ORDER BY w.name`);
  const all = states.every(s => s.state === 'deactivated');
  return [all ? 'PASS' : 'FINDING', states.map(s => `${s.name}: ${s.state}`).join(', ') +
    '. So leaving ONE workspace must never call WorkOS removeMember — that is leaving the org.'];
});

// ── report ──────────────────────────────────────────────────────────────────
await pool.end();
const pad = (s: string, n: number) => s.padEnd(n);
console.log(`\nspike: org domains — ${SPIKE_DB}\n`);
for (const r of results) {
  console.log(`${pad(r.id, 4)} ${pad(r.verdict, 8)} ${r.title}`);
  console.log(`              ${r.detail}\n`);
}
const tally = (v: Verdict) => results.filter(r => r.verdict === v).length;
console.log(`PASS ${tally('PASS')}   FINDING ${tally('FINDING')}   FAIL ${tally('FAIL')}`);
process.exit(tally('FAIL') ? 1 : 0);
