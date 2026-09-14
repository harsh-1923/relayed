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
} as const;
