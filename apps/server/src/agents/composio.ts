// The only file that imports Composio (WORKSPACE-AGENTS.md §6; the plan's
// boundary rule `agents/composio-only-here`). Every fact this rests on is
// checked against `@composio/core` 0.18.1 and its REST API directly — see
// §6.12 and `spikes/composio-connect/` for what was actually run, not read.
//
// REST throughout, never the SDK client, on purpose: the SDK's `link()`
// cannot carry `connection_data` (a toolkit's subdomain, pre-filled), its
// toolkit/tool list drops the pagination cursor, and `revoke` has no SDK
// method at all (§6.10, §6.12). One HTTP client is also one thing to time —
// every call here is `composio.request{composio_op, result}`.
import { count, histogram } from '@relayed/telemetry';
import { env } from '../env.ts';

const BASE = 'https://backend.composio.dev/api/v3.1';

type Op =
  | 'link' | 'complete_auth' | 'get_account' | 'list_accounts' | 'revoke'
  | 'delete_account' | 'list_toolkits' | 'get_toolkit' | 'list_tools' | 'create_auth_config'
  | 'create_session' | 'patch_session' | 'session_search' | 'session_execute';

/** A refusal from Composio, or from reaching it at all. Never the API key. */
export class ComposioError extends Error {
  /** 0 for a network failure — nothing answered, so there is no HTTP status to report. */
  readonly status: number;
  /** Composio's own error slug when it gave one; `network` or `http_<code>` otherwise. */
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ComposioError';
    this.status = status;
    this.code = code;
  }
}

async function call<T>(op: Op, method: string, path: string, body?: unknown): Promise<T> {
  // Absent rather than wrong: a missing key is a configuration error, not a
  // Composio outage, and callers (the connector store, the catalogue refresh)
  // need to tell the two apart.
  if (!env.composioApiKey) throw new ComposioError('COMPOSIO_API_KEY is not set', 0, 'unconfigured');

  const started = performance.now();
  let outcome: 'ok' | 'error' = 'error';
  try {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          'x-api-key': env.composioApiKey,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new ComposioError((e as Error).message, 0, 'network');
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (json['error'] ?? json) as Record<string, unknown>;
      throw new ComposioError(
        typeof err['message'] === 'string' ? err['message'] : res.statusText,
        res.status,
        typeof err['slug'] === 'string' ? err['slug'] : `http_${res.status}`,
      );
    }
    outcome = 'ok';
    return json as T;
  } finally {
    count('composio.request', { composio_op: op, result: outcome });
    histogram('composio.request.duration', performance.now() - started, { composio_op: op });
  }
}

// ─── connecting (§6.5) ───────────────────────────────────────────────────────

export interface LinkResult {
  connectedAccountId: string;
  redirectUrl: string;
  /** 10 minutes out, per §6.12. */
  expiresAt: string;
}

/**
 * Start a Composio-managed connection. `connectionData` pre-fills a field the
 * hosted form would otherwise ask for — a Jira site, a Zendesk subdomain —
 * when our own store already knows it; absent, the person is asked.
 */
export async function link(
  userId: string, authConfigId: string,
  options: { connectionData?: Record<string, unknown>; allowMultiple?: boolean } = {},
): Promise<LinkResult> {
  const body = await call<{ connected_account_id: string; redirect_url: string; expires_at: string }>(
    'link', 'POST', '/connected_accounts/link',
    {
      auth_config_id: authConfigId, user_id: userId,
      ...(options.connectionData ? { connection_data: options.connectionData } : {}),
      ...(options.allowMultiple ? { allow_multiple: true } : {}),
    },
  );
  return { connectedAccountId: body.connected_account_id, redirectUrl: body.redirect_url, expiresAt: body.expires_at };
}

export type CompleteAuthResult =
  | { ok: true; connectedAccountId: string; toolkitSlug: string }
  | { ok: false; status: number; message: string };

/**
 * The verifier's call (§6.5): holds a finished authorisation until we confirm
 * who came back. A mismatched `userId` is not an exception — it is the
 * documented, expected shape of "someone else tried to finish this" — so it
 * comes back as a value, not a throw, to keep that path un-alarming to read.
 */
export async function completeAuth(sessionUri: string, userId: string): Promise<CompleteAuthResult> {
  try {
    const body = await call<{ connected_account_id: string; toolkit_slug: string }>(
      'complete_auth', 'POST', '/connected_accounts/complete_auth',
      { session_uri: sessionUri, user_id: userId },
    );
    return { ok: true, connectedAccountId: body.connected_account_id, toolkitSlug: body.toolkit_slug };
  } catch (err) {
    if (err instanceof ComposioError && err.status === 400) {
      return { ok: false, status: err.status, message: err.message };
    }
    throw err;
  }
}

// ─── reading an account ──────────────────────────────────────────────────────

export type ConnectedAccountStatus = 'INITIALIZING' | 'INITIATED' | 'ACTIVE' | 'FAILED' | 'EXPIRED' | 'INACTIVE' | 'REVOKED';

export interface ConnectedAccount {
  id: string;
  status: ConnectedAccountStatus;
  statusReason: string | null;
  toolkitSlug: string;
  userId: string | null;
}

function toConnectedAccount(row: Record<string, unknown>): ConnectedAccount {
  return {
    id: row['id'] as string,
    status: row['status'] as ConnectedAccountStatus,
    statusReason: (row['status_reason'] as string | null) ?? null,
    toolkitSlug: ((row['toolkit'] as Record<string, unknown> | undefined)?.['slug'] as string | undefined) ?? '',
    // Deprecated in responses (§6.2) — read defensively; §6.3 is why we keep our own mapping.
    userId: (row['user_id'] as string | null | undefined) ?? null,
  };
}

/** One account, by Composio's id. Never the raw token — Composio redacts it in its own responses. */
export async function getAccount(connectedAccountId: string): Promise<ConnectedAccount> {
  const row = await call<Record<string, unknown>>(
    'get_account', 'GET', `/connected_accounts/${encodeURIComponent(connectedAccountId)}`,
  );
  return toConnectedAccount(row);
}

/** Every account for one person, across toolkits — used by reconciliation (§6.9), never by a live read. */
export async function listAccounts(userId: string): Promise<ConnectedAccount[]> {
  const body = await call<{ items: Record<string, unknown>[] }>(
    'list_accounts', 'GET', `/connected_accounts?user_ids=${encodeURIComponent(userId)}`,
  );
  return body.items.map(toConnectedAccount);
}

// ─── disconnecting (§6.10) ───────────────────────────────────────────────────

export type RevokeResult =
  | { revoked: true }
  /** `unsupported`: this toolkit cannot revoke (400). `not_active`: nothing left to revoke (409). */
  | { revoked: false; reason: 'unsupported' | 'not_active' };

/** Best effort, and first: deleting alone leaves the tokens valid at the provider (§6.10, §6.12). */
export async function revoke(connectedAccountId: string): Promise<RevokeResult> {
  try {
    await call('revoke', 'POST', `/connected_accounts/${encodeURIComponent(connectedAccountId)}/revoke`);
    return { revoked: true };
  } catch (err) {
    if (err instanceof ComposioError && err.status === 400) return { revoked: false, reason: 'unsupported' };
    if (err instanceof ComposioError && err.status === 409) return { revoked: false, reason: 'not_active' };
    throw err;
  }
}

/** Hard removal. `get`/`getAccount` 404s afterward — call `revoke` first. */
export async function deleteAccount(connectedAccountId: string): Promise<void> {
  await call('delete_account', 'DELETE', `/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
}

// ─── the catalogue (§6.6) ────────────────────────────────────────────────────

export interface ToolkitSummary {
  slug: string;
  name: string;
  description: string;
  logoUrl: string | null;
  categories: string[];
  composioManagedAuthSchemes: string[];
}

/** One page. REST, not the SDK: its list call drops `next_cursor` entirely (§6.6). */
export async function listToolkits(cursor?: string): Promise<{ items: ToolkitSummary[]; nextCursor: string | null }> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const body = await call<{ items: Record<string, unknown>[]; next_cursor: string | null }>(
    'list_toolkits', 'GET', `/toolkits${qs}`,
  );
  return {
    nextCursor: body.next_cursor,
    items: body.items.map(row => ({
      slug: row['slug'] as string,
      name: row['name'] as string,
      description: ((row['meta'] as Record<string, unknown> | undefined)?.['description'] as string | undefined) ?? '',
      logoUrl: ((row['meta'] as Record<string, unknown> | undefined)?.['logo'] as string | undefined) ?? null,
      categories: (((row['meta'] as Record<string, unknown> | undefined)?.['categories'] as { id: string }[] | undefined) ?? [])
        .map(c => c.id),
      composioManagedAuthSchemes: (row['composio_managed_auth_schemes'] as string[] | undefined) ?? [],
    })),
  };
}

export interface AuthConfigField { name: string; displayName: string; required: boolean; description: string }
export interface ToolkitAuthDetails { authScheme: string; authConfigCreation: { required: AuthConfigField[]; optional: AuthConfigField[] } }

/** One toolkit's own detail — what `getAuthConfigCreationFields` and `enable-toolkit.ts` need, direct from REST. */
export async function getToolkit(
  slug: string,
): Promise<{ authConfigDetails: ToolkitAuthDetails[]; composioManagedAuthSchemes: string[] }> {
  const row = await call<Record<string, unknown>>('get_toolkit', 'GET', `/toolkits/${encodeURIComponent(slug)}`);
  const details = (row['auth_config_details'] as Record<string, unknown>[] | undefined) ?? [];
  return {
    composioManagedAuthSchemes: (row['composio_managed_auth_schemes'] as string[] | undefined) ?? [],
    authConfigDetails: details.map(d => {
      const fields = (d['fields'] as Record<string, unknown> | undefined)?.['auth_config_creation'] as
        { required?: AuthConfigField[]; optional?: AuthConfigField[] } | undefined;
      return {
        authScheme: d['mode'] as string,
        authConfigCreation: { required: fields?.required ?? [], optional: fields?.optional ?? [] },
      };
    }),
  };
}

export interface ToolSummary {
  slug: string;
  name: string;
  description: string;
  /** MCP behaviour hints — `readOnlyHint`, `destructiveHint`, etc. Hints, not proof (§6.6). */
  hints: string[];
  important: boolean;
  deprecated: boolean;
  /**
   * JSON Schema, exactly as Composio returns it — the same shape the
   * session-tools endpoint carries (§6.7), confirmed live on THIS endpoint
   * too (2026-09; not documented, found by calling it). This is what lets
   * `dispatcher.ts` hand the runtime a real tool definition without a live
   * Composio session — and therefore without the invoker's connection having
   * to exist yet, which is exactly the case an access card is raised for.
   */
  inputSchema: Record<string, unknown>;
}

/** Every tool for one toolkit. REST: the SDK defaults to Composio's curated `important` subset (§6.6). */
export async function listTools(toolkitSlug: string, cursor?: string): Promise<{ items: ToolSummary[]; nextCursor: string | null }> {
  const qs = new URLSearchParams({ toolkit_slug: toolkitSlug, limit: '1000', ...(cursor ? { cursor } : {}) });
  const body = await call<{ items: Record<string, unknown>[]; next_cursor: string | null }>(
    'list_tools', 'GET', `/tools?${qs.toString()}`,
  );
  return {
    nextCursor: body.next_cursor,
    items: body.items.map(row => ({
      slug: row['slug'] as string,
      name: (row['name'] as string | undefined) ?? (row['slug'] as string),
      description: (row['description'] as string | undefined) ?? '',
      hints: (row['tags'] as string[] | undefined) ?? [],
      // `important` has no source on this endpoint — the SDK's own notion of
      // it comes from the curated list REST deliberately avoids (§6.6). Every
      // tool starts unmarked until something gives this a real source.
      important: false,
      // The real flag is top-level `is_deprecated`; `deprecated` (no `is_`
      // prefix) is a DIFFERENT, confusingly-named field — an object carrying
      // version history, not a boolean. Reading it as one would silently
      // store an object in a boolean column.
      deprecated: (row['is_deprecated'] as boolean | undefined) ?? false,
      inputSchema: (row['input_parameters'] as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
    })),
  };
}

// ─── sessions (§6.7) ─────────────────────────────────────────────────────────
//
// REST here too, on the `tool_router` v3.1 endpoints — not `composio.create()`,
// for the same reason as everywhere else in this file: one HTTP client.
//
// One session per PERSON, never per agent (the plan's step 7, D24): tools are
// found at run time, so nothing about a session depends on which agent is
// asking. Measured in `spikes/composio-discovery/` (2026-09-15):
//   - With `manage_connections`, `workbench` and multi-execute all off, a
//     session's meta tools shrink to search and schema lookup — nothing on it
//     can connect an account or run a tool on Composio's side.
//   - Executing does NOT need `connected_accounts` pinned: an unpinned session
//     executed for an ACTIVE account. This corrects a live check on 2026-09-14
//     (a session created with a `tools` list and `preload`) that said it did.
//     `sessions.ts` pins anyway, so the account executed is the one
//     `agent_tool_calls.connection_id` records.
//   - Composio refuses to pin an account that belongs to another `user_id`.

/** A fresh session for one person, limited to `toolkits`. `sessions.ts` decides when to reuse, patch or recreate. */
export async function createSession(
  userId: string, options: { toolkits: string[]; connectedAccounts: Record<string, string> },
): Promise<{ sessionId: string }> {
  const body = await call<{ session_id: string }>('create_session', 'POST', '/tool_router/session', {
    user_id: userId,
    toolkits: { enable: options.toolkits },
    connected_accounts: pins(options.connectedAccounts),
    // Connecting is ours (§6.5), never a tool the model can call.
    manage_connections: { enable: false },
    // No remote workbench, no remote bash (§6.7).
    workbench: { enable: false },
    // Multi-execute runs tools on Composio's side, past the broker's checks.
    execute: { enable_multi_execute: false },
  });
  return { sessionId: body.session_id };
}

/** Re-pin a session to the person's current accounts, after they connect or reconnect a toolkit. */
export async function patchSessionAccounts(sessionId: string, connectedAccounts: Record<string, string>): Promise<void> {
  await call('patch_session', 'PATCH', `/tool_router/session/${encodeURIComponent(sessionId)}`, {
    connected_accounts: pins(connectedAccounts),
  });
}

const pins = (accounts: Record<string, string>) =>
  Object.fromEntries(Object.entries(accounts).map(([toolkit, id]) => [toolkit, [id]]));

/**
 * What a search found, and only that. The raw response is never returned: it
 * carries the person's whole provider profile (`current_user_info`), the
 * Composio account id, and guidance naming tools the session does not have
 * (the plan's D27) — none of which may reach a model.
 */
export interface SearchResult {
  /** Best matches first, then related ones. Not deterministic between calls. */
  toolSlugs: string[];
  /** Schemas Composio included, by slug. It includes only the top few; the rest come from our catalogue. */
  schemas: Record<string, Record<string, unknown>>;
  /**
   * Who the session's own person is in each service it has an active account
   * for — id, name and username, never the rest of the profile. For our
   * records (`identities.ts`), never for a model.
   */
  identities?: SessionIdentity[];
}

export interface SessionIdentity {
  toolkit: string;
  connectedAccountId: string;
  externalId: string;
  name: string | null;
  username: string | null;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : null;

/**
 * The person inside a service's `current_user_info`, or null. Shapes differ by
 * service: Linear's is `{ data: { viewer: { id, name } } }`, GitHub's a flat
 * profile with `login`, Notion's the integration's BOT user with the person
 * who connected it as `bot.owner.user`. Email is never read out.
 */
export function identityFrom(info: unknown): { externalId: string; name: string | null; username: string | null } | null {
  const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const answered = record(info);
  // Notion answers with its bot; the person is whoever owns it.
  const owner = answered?.['type'] === 'bot' ? record(record(record(answered['bot'])?.['owner'])?.['user']) : null;
  const top = owner ?? answered;
  const data = record(top?.['data']);
  const candidates = [record(data?.['viewer']), record(data?.['user']), record(top?.['viewer']), record(top?.['user']), data, top];
  for (const candidate of candidates) {
    const externalId = text(candidate?.['id']) ?? text(candidate?.['user_id']) ?? text(candidate?.['account_id']);
    if (!candidate || !externalId) continue;
    return {
      externalId,
      name: text(candidate['name']) ?? text(candidate['display_name']) ?? text(candidate['displayName']) ?? text(candidate['real_name']),
      username: text(candidate['login']) ?? text(candidate['username']) ?? text(candidate['handle']) ?? text(candidate['displayName']),
    };
  }
  return null;
}

export async function searchSessionTools(sessionId: string, useCase: string): Promise<SearchResult> {
  const body = await call<{
    results?: { primary_tool_slugs?: string[]; related_tool_slugs?: string[] }[];
    tool_schemas?: Record<string, { hasFullSchema?: boolean; input_schema?: Record<string, unknown> }>;
    toolkit_connection_statuses?: {
      toolkit?: string; has_active_connection?: boolean;
      connection_details?: { connected_account_id?: string };
      current_user_info?: unknown;
    }[];
  }>('session_search', 'POST', `/tool_router/session/${encodeURIComponent(sessionId)}/search`, {
    queries: [{ use_case: useCase }],
  });
  const result = body.results?.[0];
  const toolSlugs = [...new Set([...(result?.primary_tool_slugs ?? []), ...(result?.related_tool_slugs ?? [])])];
  const schemas: Record<string, Record<string, unknown>> = {};
  for (const [slug, schema] of Object.entries(body.tool_schemas ?? {})) {
    if (schema.hasFullSchema && schema.input_schema) schemas[slug] = schema.input_schema;
  }
  const identities: SessionIdentity[] = [];
  for (const status of body.toolkit_connection_statuses ?? []) {
    const accountId = status.connection_details?.connected_account_id;
    const who = status.has_active_connection && status.toolkit && accountId ? identityFrom(status.current_user_info) : null;
    if (who && status.toolkit && accountId) identities.push({ toolkit: status.toolkit, connectedAccountId: accountId, ...who });
  }
  return { toolSlugs, schemas, identities };
}

export type ExecuteResult =
  | { ok: true; data: unknown }
  /** A 200 from Composio with its own `error` set — §6.8's "successful: false", never an HTTP failure. */
  | { ok: false; message: string };

/** Run one tool inside a session. HTTP failures (bad account, session restriction, …) throw `ComposioError`; `tool-errors.ts` maps both. */
export async function executeSessionTool(
  sessionId: string, toolSlug: string, args: Record<string, unknown>,
): Promise<ExecuteResult> {
  const body = await call<{ data: unknown; error: string | null; log_id: string }>(
    'session_execute', 'POST', `/tool_router/session/${encodeURIComponent(sessionId)}/execute`,
    { tool_slug: toolSlug, arguments: args },
  );
  return body.error ? { ok: false, message: body.error } : { ok: true, data: body.data };
}

/** A Composio-managed auth config, or `use_custom_auth` for a toolkit with none (§6.11, and the spike). */
export async function createAuthConfig(
  toolkitSlug: string,
  options: { authScheme?: string } = {},
): Promise<{ id: string }> {
  const body = options.authScheme
    ? { toolkit: { slug: toolkitSlug }, auth_config: { type: 'use_custom_auth', auth_scheme: options.authScheme, credentials: {} } }
    : { toolkit: { slug: toolkitSlug }, auth_config: { type: 'use_composio_managed_auth' } };
  const row = await call<{ auth_config: { id: string } } | { id: string }>('create_auth_config', 'POST', '/auth_configs', body);
  return { id: 'auth_config' in row ? row.auth_config.id : row.id };
}
