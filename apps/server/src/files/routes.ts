// Files over HTTP (docs/FILES.md): the upload handshake, verification, reading,
// and the first references — organization and workspace logos.
//
// The body never passes through here on the way in (§4.1). A client declares
// what it is about to upload, gets a presigned PUT bound to that hash and size,
// sends the bytes straight to the store, and then asks us to check them. Only
// after that check does a file become `ready`, and only a ready file can be
// referenced.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { count } from '@relayed/telemetry';
import { can, workspace } from '@relayed/authz';
import { db } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { env } from '../env.ts';
import { caller } from '../auth/caller.ts';
import { loadGrants } from '../authz/can.ts';
import { canOrg } from '../authz/org.ts';
import { presign, objectKey, readObject, deleteObject } from './store.ts';
import { sniff } from './sniff.ts';

type Purpose = 'logo' | 'attachment';

/**
 * What each purpose may be (§4.2). Checked on the CLAIM at declaration, so an
 * oversized upload never gets a URL, and again on the BYTES at completion.
 */
const LIMITS: Record<Purpose, { types: ReadonlySet<string> | null; maxBytes: number; maxSide: number | null }> = {
  // Raster only — the client re-encodes anything else, SVG included (§4.2).
  logo: { types: new Set(['image/png', 'image/jpeg', 'image/webp']), maxBytes: 1024 * 1024, maxSide: 1024 },
  attachment: { types: null, maxBytes: 100 * 1024 * 1024, maxSide: null },
};

/** Above this the server trusts the store's checksum rather than reading the object back (§4.3). */
const VERIFY_READ_LIMIT = 16 * 1024 * 1024;

/** Where a client reads a file. Relative: it resolves against the server it already talks to. */
export const fileUrl = (id: string) => `/files/${id}`;

/** The caller, with the org and workspace read from the ACTOR, never the token (ORG-DOMAINS.md §11.7). */
async function who(authorization: string | undefined, reply: FastifyReply) {
  const me = await caller(authorization);
  if (!me) { reply.code(401).send({ error: 'unauthenticated' }); return null; }
  const actor = await db.selectFrom('actors').select(['org_id', 'workspace_id'])
    .where('id', '=', me.actorId).executeTakeFirstOrThrow();
  return { ...me, orgId: actor.org_id, workspaceId: actor.workspace_id };
}

/** May this identity set logos anywhere in this org? Org admin, or admin of the workspace they are in. */
async function mayUploadLogo(me: { actorId: string; workspaceId: string; workosUserId: string | null; orgId: string }) {
  if (me.workosUserId && await canOrg(db, me.workosUserId, 'edit', me.orgId)) return true;
  return can(await loadGrants(db, me.actorId), 'edit', workspace(me.workspaceId));
}

/**
 * May this identity set THIS workspace's logo? Its admins — through their own
 * actor IN it, since they may be looking from another workspace and grants are
 * per actor — or its org's admins, who choose the whole org's look (§12 q1).
 */
async function mayEditWorkspaceLogo(workosUserId: string | null, ws: { id: string; org_id: string }) {
  if (!workosUserId) return false;
  const mine = await db.selectFrom('actors').select('id')
    .where('workspace_id', '=', ws.id).where('identity_kind', '=', 'workos_user')
    .where('identity_id', '=', workosUserId).where('state', '=', 'active').executeTakeFirst();
  return (mine !== undefined && can(await loadGrants(db, mine.id), 'edit', workspace(ws.id)))
    || canOrg(db, workosUserId, 'edit', ws.org_id);
}

/**
 * The org a logo upload is FOR, and whether the caller may set logos there.
 *
 * Named by the client — the org or workspace whose logo this becomes — never
 * taken from the token: an admin of two orgs sets either one's logo from
 * whichever workspace is open, and a file filed under the wrong org could not
 * be pointed at (`logoOf`). Neither named: the org they are in.
 */
async function logoTarget(
  me: NonNullable<Awaited<ReturnType<typeof who>>>, orgId: unknown, workspaceId: unknown,
): Promise<{ orgId: string } | 'forbidden' | 'not_found'> {
  if (typeof workspaceId === 'string') {
    const ws = await db.selectFrom('workspaces').select(['id', 'org_id']).where('id', '=', workspaceId).executeTakeFirst();
    if (!ws) return 'not_found';
    return await mayEditWorkspaceLogo(me.workosUserId, ws) ? { orgId: ws.org_id } : 'forbidden';
  }
  if (typeof orgId === 'string') {
    return me.workosUserId && await canOrg(db, me.workosUserId, 'edit', orgId) ? { orgId } : 'forbidden';
  }
  return await mayUploadLogo(me) ? { orgId: me.orgId } : 'forbidden';
}

/** A ready logo file of this org, or why not. */
async function logoOf(orgId: string, fileId: string | null): Promise<string | null | 'invalid'> {
  if (fileId === null) return null;
  const f = await db.selectFrom('files').select(['id', 'org_id', 'purpose', 'state'])
    .where('id', '=', fileId).executeTakeFirst();
  // Same org, and a LOGO: an attachment pointed at from here would become
  // readable by anyone holding its id (§5, §6.1).
  return f && f.org_id === orgId && f.purpose === 'logo' && f.state === 'ready' ? f.id : 'invalid';
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  /** Declare an upload. Answers with a presigned PUT, or `ready` if this org already has these bytes. */
  app.post<{ Body: { purpose?: string; sha256?: string; size?: number; media_type?: string; org_id?: string; workspace_id?: string } }>(
    '/files', async (req, reply) => {
      const store = env.objectStore;
      if (!store) return reply.code(503).send({ error: 'storage_unconfigured' });
      const me = await who(req.headers.authorization, reply);
      if (!me) return;

      const { purpose, sha256, size, media_type } = req.body ?? {};
      if (purpose !== 'logo') {
        // Attachments arrive with phase 2 (§11); until then nothing references one.
        return reply.code(400).send({ error: 'unsupported_purpose' });
      }
      if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return reply.code(400).send({ error: 'invalid_sha256' });
      if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return reply.code(400).send({ error: 'invalid_size' });
      const limit = LIMITS[purpose];
      if (size > limit.maxBytes) return reply.code(413).send({ error: 'too_large', max_bytes: limit.maxBytes });
      if (typeof media_type !== 'string' || (limit.types && !limit.types.has(media_type))) {
        return reply.code(415).send({ error: 'unsupported_type' });
      }
      // A logo is public by id (§6.1), so uploading one is the same people as
      // setting one — otherwise it is free public hosting for anyone signed in.
      const target = await logoTarget(me, req.body?.org_id, req.body?.workspace_id);
      if (target === 'not_found') return reply.code(404).send({ error: 'not_found' });
      if (target === 'forbidden') return reply.code(403).send({ error: 'forbidden', action: 'edit' });

      // The shortcut answers within THIS org only (§3).
      const have = await db.selectFrom('files').select('id')
        .where('org_id', '=', target.orgId).where('sha256', '=', sha256)
        .where('purpose', '=', purpose).where('state', '=', 'ready').executeTakeFirst();
      if (have) {
        count('files.upload', { result: 'ok' });
        return reply.send({ file_id: have.id, ready: true, url: fileUrl(have.id) });
      }

      const id = ulid('fil');
      await db.insertInto('files').values({
        id, sha256, size, media_type, width: null, height: null, purpose,
        org_id: target.orgId, uploaded_by: me.actorId,
      }).execute();

      // Bound to the declared bytes: the store refuses anything whose checksum
      // differs (verified on MinIO and R2 by scripts/r2-check.mts).
      const headers = {
        'content-type': media_type,
        'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'),
      };
      return reply.send({
        file_id: id, ready: false,
        upload: { method: 'PUT', url: presign(store, 'PUT', objectKey(sha256), { headers, expiresSec: 900 }), headers },
      });
    });

  /** The bytes are in the store; check them (§4.3). Only then is the file referenceable. */
  app.post<{ Params: { id: string } }>('/files/:id/complete', async (req, reply) => {
    const store = env.objectStore;
    if (!store) return reply.code(503).send({ error: 'storage_unconfigured' });
    const me = await who(req.headers.authorization, reply);
    if (!me) return;

    const f = await db.selectFrom('files').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    // Whoever declared it — the file may belong to another org than the one
    // they are in (`logoTarget`), so the org is no test of that.
    if (!f || f.uploaded_by !== me.actorId) return reply.code(404).send({ error: 'not_found' });
    if (f.state === 'ready') return reply.send({ file_id: f.id, url: fileUrl(f.id), media_type: f.media_type, width: f.width, height: f.height });

    const refuse = async (error: string) => {
      await db.deleteFrom('files').where('id', '=', f.id).execute();
      // The bytes may be another org's too — shared by hash (§3). Removed only
      // if no ready row anywhere still holds them.
      const shared = await db.selectFrom('files').select('id')
        .where('sha256', '=', f.sha256).where('state', '=', 'ready').executeTakeFirst();
      if (!shared) await deleteObject(store, objectKey(f.sha256)).catch(() => {});
      count('files.upload', { result: 'error' });
      return reply.code(422).send({ error });
    };

    if (f.size > VERIFY_READ_LIMIT) return refuse('too_large_to_verify');
    const bytes = await readObject(store, objectKey(f.sha256));
    if (!bytes) return reply.code(409).send({ error: 'not_uploaded' });
    if (bytes.length !== Number(f.size)) return refuse('size_mismatch');
    if (createHash('sha256').update(bytes).digest('hex') !== f.sha256) return refuse('hash_mismatch');

    const found = sniff(bytes);
    const limit = LIMITS[f.purpose];
    if (limit.types && !limit.types.has(found.mediaType)) return refuse('unsupported_type');
    if (limit.maxSide && (!found.width || !found.height || found.width > limit.maxSide || found.height > limit.maxSide)) {
      return refuse('bad_dimensions');
    }

    await db.updateTable('files').set({
      state: 'ready', media_type: found.mediaType, width: found.width, height: found.height,
    }).where('id', '=', f.id).execute();
    count('files.upload', { result: 'ok' });
    return reply.send({ file_id: f.id, url: fileUrl(f.id), media_type: found.mediaType, width: found.width, height: found.height });
  });

  /**
   * Read a file: a short-lived presigned GET, after the purpose's read rule.
   *
   * A LOGO is public by id — it is shown to people deciding whether to join,
   * who have no session of ours yet (§6.1). Nothing else is, and until message
   * attachments exist (phase 2) nothing else is readable at all.
   */
  app.get<{ Params: { id: string } }>('/files/:id', async (req, reply) => {
    const store = env.objectStore;
    if (!store) return reply.code(503).send({ error: 'storage_unconfigured' });
    const f = await db.selectFrom('files').select(['sha256', 'purpose', 'state', 'media_type'])
      .where('id', '=', req.params.id).executeTakeFirst();
    if (!f || f.state !== 'ready' || f.purpose !== 'logo') return reply.code(404).send({ error: 'not_found' });
    return reply.redirect(presign(store, 'GET', objectKey(f.sha256), {
      expiresSec: 3600, query: { 'response-content-type': f.media_type },
    }), 302);
  });

  /** An organization's logo: its admins' (FILES.md §11). `null` clears it. */
  app.put<{ Params: { id: string }; Body: { file_id?: string | null } }>('/org/:id/logo', async (req, reply) => {
    const me = await who(req.headers.authorization, reply);
    if (!me) return;
    if (!me.workosUserId || !await canOrg(db, me.workosUserId, 'edit', req.params.id)) {
      return reply.code(403).send({ error: 'forbidden', action: 'edit' });
    }
    const logo = await logoOf(req.params.id, req.body?.file_id ?? null);
    if (logo === 'invalid') return reply.code(400).send({ error: 'invalid_file' });
    await db.updateTable('organizations').set({ logo_file_id: logo }).where('id', '=', req.params.id).execute();
    return reply.send({ logo_url: logo ? fileUrl(logo) : null });
  });

  /**
   * A workspace's own logo, over its org's. Its admins' — or the org's admins',
   * who choose the whole org's look (FILES.md §12 q1).
   */
  app.put<{ Params: { id: string }; Body: { file_id?: string | null } }>('/workspaces/:id/logo', async (req, reply) => {
    const me = await who(req.headers.authorization, reply);
    if (!me) return;
    const ws = await db.selectFrom('workspaces').select(['id', 'org_id']).where('id', '=', req.params.id).executeTakeFirst();
    if (!ws) return reply.code(404).send({ error: 'not_found' });

    if (!await mayEditWorkspaceLogo(me.workosUserId, ws)) return reply.code(403).send({ error: 'forbidden', action: 'edit' });

    const logo = await logoOf(ws.org_id, req.body?.file_id ?? null);
    if (logo === 'invalid') return reply.code(400).send({ error: 'invalid_file' });
    await db.updateTable('workspaces').set({ logo_file_id: logo }).where('id', '=', ws.id).execute();
    return reply.send({ logo_url: logo ? fileUrl(logo) : null });
  });
}
