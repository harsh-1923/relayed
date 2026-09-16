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

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
};

export const env = {
  port: Number(process.env['PORT'] ?? 8787),
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

  // ── the room summariser (DOCUMENTS.md §4.4) ───────────────────────────────
  /**
   * New readable messages before a room's summary is refreshed. An env value
   * rather than a constant because it is the one number worth retuning against
   * a real deployment's rooms — too high and the panel is stale through a
   * working session, too low and it burns budget saying the same thing.
   */
  summaryThreshold: Number(process.env['SUMMARY_THRESHOLD'] ?? 15),
} as const;
