// Connecting and disconnecting a toolkit (docs/WORKSPACE-AGENTS.md §6.5, §6.10;
// the plan's step 4). Browsing the catalogue lives here too — `GET /toolkits`
// and `GET /toolkits/:slug` — since both read the same tables.
//
// The actor always comes from the session token, never the body (§6.5's
// diagram, twice over): the only thing a forged request body could do is name
// someone else's actor id, and every route here re-derives it from the
// bearer token instead.
//
// `agent_permissions` enforcement is step 5's broker (built). This file's own
// `access_request_id` "must equal actor" check (§6.5) still waits on a card
// actually carrying one through the connect flow — `access.ts` writes cards
// from the broker's own stop, not from here yet.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { count } from '@relayed/telemetry';
import type { DB } from '../db/schema.ts';
import { ulid } from '../db/ulid.ts';
import { env } from '../env.ts';
import { caller as bearerCaller, type Caller } from '../auth/caller.ts';
import { page } from '../web/landing.ts';
import { link, completeAuth, revoke, deleteAccount, ComposioError } from './composio.ts';
import { pushToActor } from '../sync/fanout.ts';
import type { Registry } from '../sync/registry.ts';

/** Ten minutes: the link and the attempt expire together (§6.5, §6.12). */
const ATTEMPT_TTL_MS = 10 * 60_000;
const COOKIE_NAME = 'relayed_connect';

export interface ConnectionRouteDeps {
  db: Kysely<DB>;
  registry: Registry;
  /** Injected so a test needs no signing key; production reads the bearer token. */
  caller?: (authorization: string | undefined) => Promise<Caller | null>;
}

interface ConnectionRow {
  id: string;
  toolkit: string;
  status: 'connecting' | 'active' | 'needs_reauth' | 'failed' | 'disconnected';
  status_reason: 'expired' | 'revoked_upstream' | 'scopes_changed' | 'failed' | null;
  label: string | null;
}

/** One row changed — pushed straight to the actor, replaced idempotently by id (§6.3). Never everyone's; a missed push is repaired by the next `welcome`. */
function pushConnection(registry: Registry, workspaceId: string, actorId: string, row: ConnectionRow): void {
  pushToActor(registry, actorId, workspaceId, 'connections', { rows: [row] });
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const sha256 = (v: string): string => createHash('sha256').update(v).digest('base64url');
const randomToken = (): string => randomBytes(32).toString('base64url');

function cookieSecret(): string {
  if (!env.connectCookieSecret) throw new Error('CONNECT_COOKIE_SECRET is not set');
  return env.connectCookieSecret;
}

/** `<attemptId>.<hmac>` — tamper-evident, not a lookup key, so `/connections/verify` never touches the database to reject a forged one. */
function signAttemptCookie(attemptId: string): string {
  return `${attemptId}.${createHmac('sha256', cookieSecret()).update(attemptId).digest('base64url')}`;
}

function verifyAttemptCookie(value: string): string | null {
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const attemptId = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(createHmac('sha256', cookieSecret()).update(attemptId).digest('base64url'));
  return sig.length === expected.length && timingSafeEqual(sig, expected) ? attemptId : null;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: 'forbidden' });
const unauthenticated = (reply: FastifyReply) => reply.code(401).send({ error: 'unauthenticated' });

function refuseComposio(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ComposioError) {
    if (err.code === 'unconfigured') return reply.code(503).send({ error: 'not_configured' });
    return reply.code(502).send({ error: 'composio_unavailable', detail: err.message });
  }
  throw err;
}

export function connectionRoutes(deps: ConnectionRouteDeps) {
  const who = deps.caller ?? bearerCaller;

  return async function register(app: FastifyInstance): Promise<void> {
    // ─── browsing (online-only) ────────────────────────────────────────────

    app.get('/toolkits', async (req, reply) => {
      if (!(await who(req.headers.authorization))) return unauthenticated(reply);
      const toolkits = await deps.db.selectFrom('toolkits')
        .select(['slug', 'name', 'description', 'logo_url', 'categories', 'auth_scheme', 'deprecated'])
        .where('enabled', '=', true)
        .orderBy('name')
        .execute();
      return reply.send({ toolkits });
    });

    app.get<{ Params: { slug: string } }>('/toolkits/:slug', async (req, reply) => {
      if (!(await who(req.headers.authorization))) return unauthenticated(reply);
      const toolkit = await deps.db.selectFrom('toolkits')
        .select(['slug', 'name', 'description', 'logo_url', 'categories', 'auth_scheme', 'auth_guide_url', 'deprecated'])
        .where('slug', '=', req.params.slug).where('enabled', '=', true)
        .executeTakeFirst();
      if (!toolkit) return notFound(reply);
      const tools = await deps.db.selectFrom('toolkit_tools')
        .select(['slug', 'name', 'description', 'hints', 'effect_derived', 'effect_override', 'important', 'deprecated'])
        .where('toolkit', '=', req.params.slug)
        .orderBy('name')
        .execute();
      return reply.send({ toolkit, tools });
    });

    // ─── connecting (§6.5) ──────────────────────────────────────────────────

    interface StartBody { toolkit?: unknown; port?: unknown; state?: unknown; access_request_id?: unknown }

    app.post<{ Body: StartBody }>('/connections', async (req, reply) => {
      const me = await who(req.headers.authorization);
      if (!me) return unauthenticated(reply);

      const toolkitSlug = str(req.body?.toolkit);
      const port = typeof req.body?.port === 'number' && Number.isInteger(req.body.port)
        && req.body.port > 0 && req.body.port < 65536 ? req.body.port : undefined;
      const state = str(req.body?.state);
      const accessRequestId = str(req.body?.access_request_id) ?? null;
      if (!toolkitSlug || !port || !state) {
        return reply.code(400).send({ error: 'invalid', reason: 'toolkit, port and state are required' });
      }
      if (!env.publicUrl) return reply.code(503).send({ error: 'not_configured', detail: 'RELAYED_PUBLIC_URL is not set' });

      const toolkit = await deps.db.selectFrom('toolkits')
        .select(['slug', 'auth_config_id', 'auth_scheme'])
        .where('slug', '=', toolkitSlug).where('enabled', '=', true)
        .executeTakeFirst();
      if (!toolkit) return notFound(reply);
      const scheme = toolkit.auth_scheme as import('@relayed/telemetry').LabelValues['connect_scheme'];

      // Reuse the same row across a reconnect (§6.5) — never a second one for
      // (actor, toolkit): the audit trail and the connector store both key on
      // this id, and it must survive the Composio id underneath it changing.
      const existing = await deps.db.selectFrom('connections')
        .select(['id', 'composio_account_id'])
        .where('actor_id', '=', me.actorId).where('toolkit', '=', toolkitSlug)
        .orderBy('created_at', 'desc').executeTakeFirst();

      let linked;
      try {
        linked = await link(me.actorId, toolkit.auth_config_id);
      } catch (err) {
        count('connection.flow', { connect_scheme: scheme, connect_stage: 'link', result: 'error' });
        return refuseComposio(reply, err);
      }
      count('connection.flow', { connect_scheme: scheme, connect_stage: 'link', result: 'ok' });

      // Best effort: link() only succeeds once the old account is EXPIRED or
      // REVOKED (Composio refuses otherwise), so it is safe to delete now
      // rather than wait for this attempt to finish (§6.5's "Reconnecting").
      if (existing?.composio_account_id && existing.composio_account_id !== linked.connectedAccountId) {
        await deleteAccount(existing.composio_account_id).catch(() => {});
      }

      const connectionId = existing?.id ?? ulid('con');
      if (existing) {
        await deps.db.updateTable('connections').set({
          composio_account_id: linked.connectedAccountId, status: 'connecting',
          status_reason: null, connected_at: null, updated_at: sql`now()`,
        }).where('id', '=', existing.id).execute();
      } else {
        await deps.db.insertInto('connections').values({
          id: connectionId, workspace_id: me.workspaceId, actor_id: me.actorId, toolkit: toolkitSlug,
          composio_account_id: linked.connectedAccountId, status: 'connecting',
        }).execute();
      }
      pushConnection(deps.registry, me.workspaceId, me.actorId,
        { id: connectionId, toolkit: toolkitSlug, status: 'connecting', status_reason: null, label: null });

      const rawToken = randomToken();
      await deps.db.insertInto('connection_attempts').values({
        id: ulid('cta'), connection_id: connectionId, actor_id: me.actorId,
        start_token_hash: sha256(rawToken), redirect_url: linked.redirectUrl,
        port, state, access_request_id: accessRequestId,
        expires_at: new Date(Date.now() + ATTEMPT_TTL_MS),
      }).execute();

      return reply.code(201).send({
        connection_id: connectionId,
        start_url: `${env.publicUrl}/connections/start?t=${encodeURIComponent(rawToken)}`,
      });
    });

    /** Spends the one-time start token, sets the attempt cookie, and sends the browser on to Composio's hosted page. */
    app.get<{ Querystring: { t?: string } }>('/connections/start', async (req, reply) => {
      const raw = req.query.t;
      if (!raw) return reply.code(400).type('text/html').send(page('Nothing to connect', '<h1>Nothing to connect</h1><p>This link is missing its token.</p>'));

      const attempt = await deps.db.selectFrom('connection_attempts')
        .innerJoin('connections', 'connections.id', 'connection_attempts.connection_id')
        .innerJoin('toolkits', 'toolkits.slug', 'connections.toolkit')
        .select(['connection_attempts.id as id', 'connection_attempts.redirect_url as redirect_url',
                 'connection_attempts.expires_at as expires_at', 'connection_attempts.consumed_at as consumed_at',
                 'toolkits.auth_scheme as auth_scheme'])
        .where('connection_attempts.start_token_hash', '=', sha256(raw))
        .executeTakeFirst();

      const scheme = attempt?.auth_scheme as import('@relayed/telemetry').LabelValues['connect_scheme'] | undefined;
      if (!attempt || attempt.consumed_at || new Date(attempt.expires_at) < new Date()) {
        if (scheme) count('connection.flow', { connect_scheme: scheme, connect_stage: 'start', result: 'error' });
        return reply.code(410).type('text/html').send(page('Link expired',
          '<h1>This link has expired</h1><p>Start connecting again from Relayed.</p>'));
      }

      await deps.db.updateTable('connection_attempts').set({ consumed_at: sql`now()` })
        .where('id', '=', attempt.id).execute();
      count('connection.flow', { connect_scheme: scheme!, connect_stage: 'start', result: 'ok' });

      reply.header('set-cookie',
        `${COOKIE_NAME}=${signAttemptCookie(attempt.id)}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/connections`);
      return reply.redirect(attempt.redirect_url, 302);
    });

    /**
     * Where Composio's "OAuth user verification" project setting sends the
     * browser once authorisation finishes — a fixed URL, not per-request
     * (§6.5). The only thing naming which attempt this is IS the cookie: with
     * verification on, Composio ignores `callback_url` and appends only
     * `session_uri`.
     */
    app.get<{ Querystring: { session_uri?: string } }>('/connections/verify', async (req, reply) => {
      const sessionUri = req.query.session_uri;
      const attemptId = verifyAttemptCookie(readCookie(req.headers.cookie, COOKIE_NAME) ?? '');
      if (!sessionUri || !attemptId) {
        // No toolkit to attribute this to — a forged or foreign request, not
        // a real attempt's failure — so no `connection.flow` count here.
        return reply.code(400).type('text/html').send(page('Nothing to verify',
          '<h1>Nothing to verify</h1><p>Open Relayed and try connecting again.</p>'));
      }

      const attempt = await deps.db.selectFrom('connection_attempts')
        .innerJoin('connections', 'connections.id', 'connection_attempts.connection_id')
        .innerJoin('toolkits', 'toolkits.slug', 'connections.toolkit')
        .select(['connection_attempts.port as port', 'connection_attempts.state as state',
                 'connection_attempts.expires_at as expires_at', 'toolkits.auth_scheme as auth_scheme'])
        .where('connection_attempts.id', '=', attemptId)
        .executeTakeFirst();

      reply.header('set-cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/connections`);

      if (!attempt || new Date(attempt.expires_at) < new Date()) {
        if (attempt) {
          count('connection.flow', {
            connect_scheme: attempt.auth_scheme as import('@relayed/telemetry').LabelValues['connect_scheme'],
            connect_stage: 'verify', result: 'error',
          });
        }
        return reply.code(410).type('text/html').send(page('Link expired',
          '<h1>This connection attempt has expired</h1><p>Start connecting again from Relayed.</p>'));
      }
      count('connection.flow', {
        connect_scheme: attempt.auth_scheme as import('@relayed/telemetry').LabelValues['connect_scheme'],
        connect_stage: 'verify', result: 'ok',
      });

      const dest = new URL(`http://127.0.0.1:${attempt.port}/connected`);
      dest.searchParams.set('session_uri', sessionUri);
      dest.searchParams.set('state', attempt.state);
      return reply.redirect(dest.toString(), 302);
    });

    /** The loopback listener's own call, once its `state` check passes. */
    app.post<{ Params: { id: string }; Body: { session_uri?: unknown } }>(
      '/connections/:id/complete', async (req, reply) => {
        const me = await who(req.headers.authorization);
        if (!me) return unauthenticated(reply);
        const sessionUri = str(req.body?.session_uri);
        if (!sessionUri) return reply.code(400).send({ error: 'invalid', field: 'session_uri' });

        const conn = await deps.db.selectFrom('connections')
          .innerJoin('toolkits', 'toolkits.slug', 'connections.toolkit')
          .select(['connections.id as id', 'connections.actor_id as actor_id', 'connections.status as status',
                   'connections.toolkit as toolkit', 'connections.composio_account_id as composio_account_id',
                   'toolkits.auth_scheme as auth_scheme'])
          .where('connections.id', '=', req.params.id)
          .executeTakeFirst();
        if (!conn) return notFound(reply);
        // Nobody else finishes a connection — checked BEFORE Composio is ever
        // called, so a forged actor never spends a real complete_auth call.
        if (conn.actor_id !== me.actorId) return forbidden(reply);
        if (conn.status !== 'connecting') return reply.send({ connection_id: conn.id, status: conn.status });

        const scheme = conn.auth_scheme as import('@relayed/telemetry').LabelValues['connect_scheme'];
        const result = await completeAuth(sessionUri, me.actorId);
        if (!result.ok) {
          count('connection.flow', { connect_scheme: scheme, connect_stage: 'complete', result: 'error' });
          await deps.db.updateTable('connections')
            .set({ status: 'failed', status_reason: 'failed', updated_at: sql`now()` })
            .where('id', '=', conn.id).execute();
          pushConnection(deps.registry, me.workspaceId, me.actorId,
            { id: conn.id, toolkit: conn.toolkit, status: 'failed', status_reason: 'failed', label: null });
          return reply.code(409).send({ error: 'complete_auth_failed', detail: result.message });
        }
        // Composio confirmed a DIFFERENT account than the one this attempt's
        // link() minted — never trust it over what we stored at link() time.
        if (conn.composio_account_id && result.connectedAccountId !== conn.composio_account_id) {
          count('connection.flow', { connect_scheme: scheme, connect_stage: 'complete', result: 'error' });
          return reply.code(409).send({ error: 'account_mismatch' });
        }

        await deps.db.updateTable('connections').set({
          status: 'active', status_reason: null, connected_at: sql`now()`, updated_at: sql`now()`,
        }).where('id', '=', conn.id).execute();
        count('connection.flow', { connect_scheme: scheme, connect_stage: 'complete', result: 'ok' });
        pushConnection(deps.registry, me.workspaceId, me.actorId,
          { id: conn.id, toolkit: conn.toolkit, status: 'active', status_reason: null, label: null });
        return reply.send({ connection_id: conn.id, status: 'active' });
      });

    /**
     * The desktop's own admission that a connect attempt did not finish — the
     * browser closed, the loopback listener timed out, or the state check
     * failed — none of which ever reaches `/complete`. Without this a row sits
     * at `connecting` forever: nothing else ever revisits it, so the connector
     * store would show "Connecting…" for good on a browser tab the person
     * already closed. Same shape as `/complete`'s own failure branch, because
     * it is the same fact reaching the row from a different door.
     */
    app.post<{ Params: { id: string } }>('/connections/:id/fail', async (req, reply) => {
      const me = await who(req.headers.authorization);
      if (!me) return unauthenticated(reply);

      const conn = await deps.db.selectFrom('connections')
        .select(['id', 'actor_id', 'status', 'toolkit'])
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!conn) return notFound(reply);
      if (conn.actor_id !== me.actorId) return forbidden(reply);
      // Idempotent, and never overwrites an outcome that already landed —
      // a slow local timeout firing after Composio's redirect already
      // completed the row must not un-succeed it.
      if (conn.status !== 'connecting') return reply.send({ connection_id: conn.id, status: conn.status });

      await deps.db.updateTable('connections')
        .set({ status: 'failed', status_reason: 'failed', updated_at: sql`now()` })
        .where('id', '=', conn.id).execute();
      pushConnection(deps.registry, me.workspaceId, me.actorId,
        { id: conn.id, toolkit: conn.toolkit, status: 'failed', status_reason: 'failed', label: null });
      return reply.send({ connection_id: conn.id, status: 'failed' });
    });

    // ─── disconnecting (§6.10) ──────────────────────────────────────────────

    app.delete<{ Params: { id: string } }>('/connections/:id', async (req, reply) => {
      const me = await who(req.headers.authorization);
      if (!me) return unauthenticated(reply);

      const conn = await deps.db.selectFrom('connections')
        .innerJoin('toolkits', 'toolkits.slug', 'connections.toolkit')
        .select(['connections.id as id', 'connections.actor_id as actor_id', 'connections.status as status',
                 'connections.toolkit as toolkit', 'connections.composio_account_id as composio_account_id',
                 'toolkits.auth_scheme as auth_scheme'])
        .where('connections.id', '=', req.params.id)
        .executeTakeFirst();
      if (!conn) return notFound(reply);
      if (conn.actor_id !== me.actorId) return forbidden(reply);
      const scheme = conn.auth_scheme as import('@relayed/telemetry').LabelValues['connect_scheme'];
      if (conn.status === 'disconnected') return reply.send({ connection_id: conn.id, status: 'disconnected', revoked: false });

      // Revoke first, then delete, always — deleting alone leaves the tokens
      // valid at the provider (§6.10). Delete runs even when revoke says
      // unsupported or already-inactive; both still mean "nothing left to
      // revoke", never "stop here".
      let revoked = false;
      if (conn.composio_account_id) {
        try {
          const rev = await revoke(conn.composio_account_id);
          revoked = rev.revoked;
          await deleteAccount(conn.composio_account_id).catch(() => {});
        } catch (err) {
          count('connection.flow', { connect_scheme: scheme, connect_stage: 'disconnect', result: 'error' });
          return refuseComposio(reply, err);
        }
      }

      await deps.db.updateTable('connections').set({
        status: 'disconnected', disconnected_at: sql`now()`, updated_at: sql`now()`,
      }).where('id', '=', conn.id).execute();
      count('connection.flow', { connect_scheme: scheme, connect_stage: 'disconnect', result: 'ok' });
      pushConnection(deps.registry, me.workspaceId, me.actorId,
        { id: conn.id, toolkit: conn.toolkit, status: 'disconnected', status_reason: null, label: null });

      // Permissions are kept (§6.4) — reconnecting never asks Bob to re-allow
      // an agent he already allowed.
      return reply.send({ connection_id: conn.id, status: 'disconnected', revoked });
    });
  };
}
