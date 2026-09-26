/**
 * `/dev` routes write what no client can and authenticate nothing, so a
 * production process with the flag set refuses to boot rather than trusting
 * that nobody set it.
 */
const devRoutes = (): boolean => {
  const on = process.env['RELAYED_DEV_ROUTES'] === '1';
  if (on && process.env['NODE_ENV'] === 'production') {
    throw new Error('RELAYED_DEV_ROUTES must not be set in production');
  }
  return on;
};

/** Unset is `live` — on by default. Anything set and unrecognised is off: a typo must not switch it on. */
function ambientMode(value: string | undefined): 'off' | 'shadow' | 'live' {
  if (value === undefined || value.trim() === '') return 'live';
  return value === 'shadow' || value === 'live' ? value : 'off';
}

/**
 * Handles, or NULL for "every agent". An EMPTY value is NULL too: `.env.example`
 * ships the line blank, and a copied blank line must not quietly switch every
 * agent off.
 */
function handleList(value: string | undefined): string[] | null {
  const handles = value?.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean) ?? [];
  return handles.length > 0 ? handles : null;
}

/** A positive number of seconds, or the default — `Number('')` is 0, and a lull of 0 is no first refusal at all. */
function seconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The object store (FILES.md), or null. OPTIONAL like memory and the agent
 * runtime: a server without it boots and serves everything else, and the
 * upload routes answer `storage_unconfigured`. All four credentials or none — a
 * half-set store is a misconfiguration to report, not a store to half-use.
 */
function objectStore() {
  const endpoint = process.env['S3_ENDPOINT'];
  const bucket = process.env['S3_BUCKET'];
  const accessKeyId = process.env['S3_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['S3_SECRET_ACCESS_KEY'];
  const set = [endpoint, bucket, accessKeyId, secretAccessKey].filter(Boolean).length;
  if (set === 0) return null;
  if (set < 4) throw new Error('S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are all or nothing');
  return {
    endpoint: endpoint!.replace(/\/+$/, ''), bucket: bucket!, accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!, region: process.env['S3_REGION'] || 'auto',
    // MinIO needs path-style; R2 and S3 accept it too, so it is the safe default.
    forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] !== 'false',
  };
}

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
};

export const env = {
  port: Number(process.env['PORT'] ?? 8787),
  /**
   * LOOPBACK BY DEFAULT, and a container has to say otherwise.
   *
   * A development machine that bound 0.0.0.0 would put an unauthenticated
   * `/dev` surface on whatever café network it is joined to. A container's
   * loopback, meanwhile, reaches nothing outside it — so a deployment that
   * forgets `HOST` fails by being unreachable, which is loud, rather than by
   * being exposed, which is silent.
   */
  host: process.env['HOST'] ?? '127.0.0.1',
  databaseUrl: required('DATABASE_URL'),
  workosClientId: required('WORKOS_CLIENT_ID'),
  /** Only needed for Management API calls (orgs, invitations) — never for auth. */
  workosApiKey: process.env['WORKOS_API_KEY'] ?? null,
  /** Ed25519 private key (PKCS#8 PEM) used to sign our session tokens. */
  sessionPrivateKey: process.env['SESSION_PRIVATE_KEY'] ?? null,
  /** Ed25519 public key (SPKI PEM). Verify-only services need just this. */
  sessionPublicKey: process.env['SESSION_PUBLIC_KEY'] ?? null,
  accessTokenTtlSec: Number(process.env['ACCESS_TOKEN_TTL'] ?? 900),        // 15 min
  refreshTokenTtlSec: Number(process.env['REFRESH_TOKEN_TTL'] ?? 2592000),  // 30 days
  otlpEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? null,
  /** Registers `/dev` routes (web/dev.ts). Never set outside a developer's machine. */
  devRoutes: devRoutes(),

  // ── Memory (docs/MEMORY.md) ─────────────────────────────────────────────
  //
  // OPTIONAL, the same way the agent runtime's settings are: a server with no
  // memory configured must still boot and serve every other feature. The
  // ingest job and the recall path check these themselves and stay off rather
  // than failing a run that would otherwise have worked without memory.
  //
  // Cloud for now; self-hosted once there is real usage, which is when the
  // extraction model becomes ours to choose (§13).
  hindsightBaseUrl: process.env['HINDSIGHT_BASE_URL'] ?? null,
  hindsightApiKey: process.env['HINDSIGHT_API_KEY'] ?? null,
  /**
   * REST-path tenant. The TypeScript client has no tenant option and addresses
   * `/v1/default/`, so this is only read by anything calling the API directly.
   */
  hindsightTenant: process.env['HINDSIGHT_TENANT'] ?? 'default',
  /**
   * Ingestion runs only when this is set. Off by default, and separately from
   * whether Hindsight is configured — a workspace can be reading memory that
   * already exists while nothing new is being written.
   */
  memoryIngest: process.env['MEMORY_INGEST'] === '1',
  /**
   * Recall runs on an agent run only when this is set. Separate from
   * `MEMORY_INGEST` on purpose — a deployment can read memory that already
   * exists while writing none, and the two are turned on in different stages.
   *
   * Off by default, which is also what keeps the dispatcher's tests from
   * reaching a real Hindsight: a feature that costs a network round trip per
   * run should be opted into, not inherited from an API key being present.
   */
  memoryRecall: process.env['MEMORY_RECALL'] === '1',
  /**
   * Restricts ingestion to these space ids. NULL means every eligible space.
   *
   * The first room is chosen deliberately rather than discovered: the point of
   * stage 2 is a person reading one room's facts and judging them, which needs
   * to be a room whose conversation they recognise.
   */
  memoryIngestSpaces: process.env['MEMORY_INGEST_SPACES']?.split(',').map(s => s.trim())
    .filter(Boolean) ?? null,

  // ── workspace agents, step 3 (WORKSPACE-AGENTS-IMPL.md §4.2) ─────────────
  //
  // All three OPTIONAL, and deliberately: a server with no runtime configured
  // must still boot (the plan's D5) — every other feature works without an
  // agent ever running. The dispatcher checks these itself at startup and
  // logs which is missing rather than the process refusing to start.
  /** Internal address of `apps/agent`. */
  agentRuntimeUrl: process.env['AGENT_RUNTIME_URL'] ?? null,
  /** The runtime's own `x-agent-key`; the server now holds it too, to call `/run`. */
  agentS2sKey: process.env['AGENT_S2S_KEY'] ?? null,
  /** Signs the tool-call grant (D4). A separate secret and audience from session tokens — never in `apps/agent`. */
  agentGrantSecret: process.env['AGENT_GRANT_SECRET'] ?? null,

  // ── connections, through Composio (WORKSPACE-AGENTS.md §6) ────────────────
  //
  // Optional, like the agent-runtime trio above: the connector store and the
  // catalogue refresh check this themselves and answer "not configured"
  // rather than the process refusing to boot (D5's reasoning, again).
  /** The project's scoped key (§6.2). Lives here and nowhere else (invariant 75). */
  composioApiKey: process.env['COMPOSIO_API_KEY'] ?? null,
  /** Base for `start_url` and the Composio verifier callback (§6.5) — must be reachable by Composio's servers, never localhost. */
  publicUrl: process.env['RELAYED_PUBLIC_URL'] ?? null,
  /** Signs the `relayed_connect` cookie (§6.5). A separate secret from every other signing key here, on the same reasoning as `AGENT_GRANT_SECRET`. */
  connectCookieSecret: process.env['CONNECT_COOKIE_SECRET'] ?? null,

  // ── web search, through Parallel (WORKSPACE-AGENTS.md §5.5) ──────────────
  /**
   * Parallel's API key. Optional, like everything above it: a server without
   * one still answers every run, just without the `web_search` tool, which is
   * not offered at all when this is unset.
   *
   * Setting it is the whole decision. There is no second switch beside it, as
   * memory has, because nothing else uses this key — see the note on the
   * tool's own `definition`.
   */
  parallelApiKey: process.env['PARALLEL_API_KEY'] ?? null,

  // ── the room summariser (DOCUMENTS.md §4.4) ───────────────────────────────
  /**
   * New readable messages before a room's summary is refreshed. An env value
   * rather than a constant because it is the one number worth retuning against
   * a real deployment's rooms — too high and the panel is stale through a
   * working session, too low and it burns budget saying the same thing.
   */
  summaryThreshold: Number(process.env['SUMMARY_THRESHOLD'] ?? 15),

  // ── ambient answers (AMBIENT-RESPONSES.md) ────────────────────────────────
  //
  // On by default, but still optional: without a key nothing ambient runs,
  // the server says so at boot, and every other feature is untouched —
  // mentions never call TypeSafe at all.
  /** TypeSafe's key, for Jev. */
  typesafeApiKey: process.env['TYPESAFE_API_KEY'] ?? null,
  /** Where TypeSafe is. Only a test or a proxy points it anywhere else. */
  typesafeBaseUrl: process.env['TYPESAFE_BASE_URL'] ?? 'https://api.typesafe.ai',
  /**
   * `off`, `shadow` or `live` (§10.1). LIVE WHEN UNSET, since the first release
   * (2026-09-24): answers ship on so that people can say what they think of
   * them. `off` switches it off; anything else unrecognised is off too, so a
   * typo never turns it on.
   */
  ambientMode: ambientMode(process.env['AMBIENT_MODE']),
  /**
   * Restricts ambient answers to these agent handles. NULL is every agent. The
   * rollout switch, in the shape `MEMORY_INGEST_SPACES` already has (§10.3).
   */
  ambientAgents: handleList(process.env['AMBIENT_AGENTS']),
  /** Seconds after a person's last message before their turn is looked at — first refusal (§3). A guess to be tuned. */
  ambientLullSec: seconds(process.env['AMBIENT_LULL_SEC'], 90),

  // ── files (FILES.md) ─────────────────────────────────────────────────────
  /** S3-compatible: MinIO locally, R2 in production. Null when unset. */
  objectStore: objectStore(),
} as const;
