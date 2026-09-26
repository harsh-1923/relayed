// Integration: files and logos over HTTP (docs/FILES.md), against the real
// object store — MinIO in `pnpm services`. Only WorkOS is faked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { env } from '../env.ts';
import { signAccessToken } from '../auth/tokens.ts';
import { fileRoutes } from './routes.ts';
import { createWorkspace, createWorkspaceInOrg, resolveMemberships, type Identity } from '../provisioning/provision.ts';
import { joinWorkspace } from '../provisioning/join.ts';
import { sniff } from './sniff.ts';

const up = await reachable();
const opts = up && env.objectStore ? {} : { skip: 'postgres or object store not reachable — run `pnpm services`' };

/** A real PNG of the given size — enough for the sniffer and the limits to judge. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;   // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const tag = ulid('t').slice(-8).toLowerCase();
const person = (name: string): Identity => ({
  workosUserId: `wu_${name}_${tag}`, email: `${name}@acme-${tag}.test`, emailVerified: true,
  displayName: name, avatarUrl: null,
});
const asha = person('asha'), ravi = person('ravi');
const W = { members: [] as { user_id: string; organization_id: string }[], seq: 0 };
const original = globalThis.fetch;
let app: FastifyInstance;
let acme: Awaited<ReturnType<typeof createWorkspace>>;
let side: Awaited<ReturnType<typeof createWorkspaceInOrg>>;
let other: Awaited<ReturnType<typeof createWorkspace>>;
let second: Awaited<ReturnType<typeof createWorkspace>>;
let ashaToken = '', raviToken = '', otherToken = '';

before(async () => {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.host !== 'api.workos.com') return original(input, init);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, string> : {};
    const json = (x: unknown) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/organizations') return json({ id: `wo_${tag}_${++W.seq}`, name: body['name'] });
    if (init?.method === 'POST') { W.members.push({ user_id: body['user_id']!, organization_id: body['organization_id']! }); return json({ id: 'om' }); }
    return json({ data: W.members.filter(m => m.user_id === u.searchParams.get('user_id')) });
  }) as typeof fetch;
  if (!up || !env.objectStore) return;

  app = Fastify(); await app.register(fileRoutes); await app.ready();
  acme = await createWorkspace(db, asha, { workspaceName: 'Acme', handle: 'asha' });
  side = await createWorkspaceInOrg(db, asha, acme.orgId, { workspaceName: 'Side', handle: 'asha' });
  other = await createWorkspace(db, person('olga'), { workspaceName: 'Other', handle: 'olga' });
  second = await createWorkspace(db, asha, { workspaceName: 'Asha Two', handle: 'asha' });   // Asha owns two orgs
  W.members.push({ user_id: ravi.workosUserId,
    organization_id: (await db.selectFrom('organizations').select('workos_org_id').where('id', '=', acme.orgId).executeTakeFirstOrThrow()).workos_org_id });
  const joined = await joinWorkspace(db, ravi, acme.workspaceId, 'ravi');
  if (typeof joined !== 'object') throw new Error(`seed: ${joined}`);
  const token = (actorId: string, orgId: string, workspaceId: string) =>
    signAccessToken({ actorId, orgId, workspaceId, deviceId: 'dev_files', sessionId: ulid('ses') });
  ashaToken = await token(acme.actorId, acme.orgId, acme.workspaceId);
  raviToken = await token(joined.actorId, acme.orgId, acme.workspaceId);
  otherToken = await token(other.actorId, other.orgId, other.workspaceId);
});

after(async () => {
  globalThis.fetch = original;
  if (!up || !env.objectStore) return;
  await app.close();
  for (const org of [acme.orgId, other.orgId, second.orgId]) {
    await db.updateTable('organizations').set({ logo_file_id: null }).where('id', '=', org).execute();
    await db.updateTable('workspaces').set({ logo_file_id: null }).where('org_id', '=', org).execute();
    await db.deleteFrom('files').where('org_id', '=', org).execute();
    await db.deleteFrom('spaces').where('org_id', '=', org).execute();
    await db.deleteFrom('workos_memberships').where('workos_org_id', 'like', `wo_${tag}%`).execute();
    await db.deleteFrom('organizations').where('id', '=', org).execute();
  }
  await pool.end();
});

const as = (token: string) => ({ authorization: `Bearer ${token}` });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const declare = (token: string, body: object) => app.inject({ method: 'POST', url: '/files', headers: as(token), payload: body });

/** The whole §4.1 handshake, as the desktop runs it. */
async function upload(token: string, bytes: Buffer, mediaType = 'image/png', target: object = {}) {
  const d = await declare(token, { purpose: 'logo', sha256: sha(bytes), size: bytes.length, media_type: mediaType, ...target });
  if (d.statusCode !== 200) return d;
  const body = d.json();
  if (!body.ready) {
    const put = await original(body.upload.url, { method: 'PUT', headers: body.upload.headers, body: bytes });
    assert.equal(put.status, 200, `PUT to the store: ${await put.text()}`);
  }
  return app.inject({ method: 'POST', url: `/files/${body.file_id}/complete`, headers: as(token) });
}

test('the sniffer reads type and size from the bytes, not the name', () => {
  assert.deepEqual(sniff(png(300, 200)), { mediaType: 'image/png', width: 300, height: 200 });
  assert.equal(sniff(Buffer.from('<html>not a png</html>')).mediaType, 'application/octet-stream');
});

test('an org admin uploads a logo: verified, ready, and readable by id without a session', opts, async () => {
  const bytes = png(64, 64);
  const done = await upload(ashaToken, bytes);
  assert.equal(done.statusCode, 200, done.body);
  const file = done.json();
  assert.deepEqual([file.media_type, file.width, file.height], ['image/png', 64, 64]);

  const read = await app.inject({ method: 'GET', url: `/files/${file.file_id}` });   // no Authorization
  assert.equal(read.statusCode, 302);
  const fetched = await original(read.headers.location as string);
  assert.equal(fetched.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await fetched.arrayBuffer()).equals(bytes));

  // The same bytes again: the org already has them, no second upload.
  const again = await declare(ashaToken, { purpose: 'logo', sha256: sha(bytes), size: bytes.length, media_type: 'image/png' });
  assert.deepEqual([again.json().ready, again.json().file_id], [true, file.file_id]);
});

test('uploading a logo is for those who can set one', opts, async () => {
  const bytes = png(8, 8);
  const r = await declare(raviToken, { purpose: 'logo', sha256: sha(bytes), size: bytes.length, media_type: 'image/png' });
  assert.equal(r.statusCode, 403, 'a plain member would otherwise have free public hosting');
});

test('refused before any URL is issued: too big, SVG, attachments for now', opts, async () => {
  const h = sha(Buffer.from('x'));
  assert.equal((await declare(ashaToken, { purpose: 'logo', sha256: h, size: 2 * 1024 * 1024, media_type: 'image/png' })).statusCode, 413);
  assert.equal((await declare(ashaToken, { purpose: 'logo', sha256: h, size: 10, media_type: 'image/svg+xml' })).statusCode, 415);
  assert.equal((await declare(ashaToken, { purpose: 'attachment', sha256: h, size: 10, media_type: 'application/pdf' })).json().error, 'unsupported_purpose');
});

test('bytes that are not what was claimed never become ready', opts, async () => {
  const html = Buffer.from(`<html>${tag}</html>`);
  const r = await upload(ashaToken, html, 'image/png');   // declared PNG; the bytes say otherwise
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().error, 'unsupported_type');
  const row = await db.selectFrom('files').select('id').where('sha256', '=', sha(html)).executeTakeFirst();
  assert.equal(row, undefined, 'the refused row is gone');

  const huge = png(2000, 10);
  assert.equal((await upload(ashaToken, huge)).json().error, 'bad_dimensions');
});

test('setting logos: org admins only, the org logo shows through, a workspace logo wins', opts, async () => {
  const orgLogo = (await upload(ashaToken, png(32, 32))).json().file_id as string;
  const put = (token: string, url: string, file_id: string | null) =>
    app.inject({ method: 'PUT', url, headers: as(token), payload: { file_id } });

  assert.equal((await put(raviToken, `/org/${acme.orgId}/logo`, orgLogo)).statusCode, 403);
  assert.equal((await put(ashaToken, `/org/${acme.orgId}/logo`, orgLogo)).statusCode, 200);
  let rows = await resolveMemberships(db, asha.workosUserId);
  assert.ok(rows.filter(m => m.orgId === acme.orgId).every(m => m.workspaceAvatarUrl === `/files/${orgLogo}`), 'every workspace inherits the org logo');

  const sideLogo = (await upload(ashaToken, png(16, 16))).json().file_id as string;
  assert.equal((await put(ashaToken, `/workspaces/${side.workspaceId}/logo`, sideLogo)).statusCode, 200);
  rows = await resolveMemberships(db, asha.workosUserId);
  assert.equal(rows.find(m => m.workspaceId === side.workspaceId)?.workspaceAvatarUrl, `/files/${sideLogo}`);
  assert.equal(rows.find(m => m.workspaceId === acme.workspaceId)?.workspaceAvatarUrl, `/files/${orgLogo}`);

  // Another org cannot point its logo at this org's file.
  assert.equal((await put(otherToken, `/org/${other.orgId}/logo`, orgLogo)).json().error, 'invalid_file');

  assert.equal((await put(ashaToken, `/org/${acme.orgId}/logo`, null)).statusCode, 200);
  rows = await resolveMemberships(db, asha.workosUserId);
  assert.equal(rows.find(m => m.workspaceId === acme.workspaceId)?.workspaceAvatarUrl, null, 'cleared: initials again');
});

test('a logo is filed under the org it is for, not the one the uploader is signed in to', opts, async () => {
  const put = (token: string, url: string, file_id: string | null) =>
    app.inject({ method: 'PUT', url, headers: as(token), payload: { file_id } });

  // Signed in to Acme, setting the logo of her other org.
  const forSecond = await upload(ashaToken, png(20, 20), 'image/png', { org_id: second.orgId });
  assert.equal(forSecond.statusCode, 200, forSecond.body);
  const fileId = forSecond.json().file_id as string;
  const row = await db.selectFrom('files').select('org_id').where('id', '=', fileId).executeTakeFirstOrThrow();
  assert.equal(row.org_id, second.orgId);
  assert.equal((await put(ashaToken, `/org/${second.orgId}/logo`, fileId)).statusCode, 200);

  // By workspace, the same.
  const forWs = (await upload(ashaToken, png(22, 22), 'image/png', { workspace_id: second.workspaceId })).json().file_id as string;
  assert.equal((await put(ashaToken, `/workspaces/${second.workspaceId}/logo`, forWs)).statusCode, 200);

  // Naming an org she does not run is refused before a URL is issued.
  const b = png(12, 12);
  const refused = await declare(ashaToken, { purpose: 'logo', sha256: sha(b), size: b.length, media_type: 'image/png', org_id: other.orgId });
  assert.equal(refused.statusCode, 403);
  assert.equal((await declare(raviToken, { purpose: 'logo', sha256: sha(b), size: b.length, media_type: 'image/png', workspace_id: acme.workspaceId })).statusCode, 403);

  // Nobody finishes an upload they did not declare.
  const c = png(28, 28);
  const pending = await declare(otherToken, { purpose: 'logo', sha256: sha(c), size: c.length, media_type: 'image/png' });
  const hijack = await app.inject({ method: 'POST', url: `/files/${pending.json().file_id}/complete`, headers: as(ashaToken) });
  assert.equal(hijack.statusCode, 404);
});
