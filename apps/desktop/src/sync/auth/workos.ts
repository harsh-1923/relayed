// WorkOS AuthKit as a PUBLIC OAuth client (PHASE-1-IDENTITY.md §6).
//
// No API key is involved anywhere in this file. The desktop app cannot hold a
// secret — it is extractable from the asar — so the application is configured
// Public in the WorkOS dashboard and PKCE replaces the client secret. Verified
// against staging: the token endpoint accepts client_id + code_verifier alone.
//
// Management API calls (creating orgs, actors, invitations) DO need the secret
// and therefore belong on the server, never here.
import type { Pkce } from './pkce.ts';

const API = 'https://api.workos.com';

export interface WorkOSConfig {
  clientId: string;
  apiBase?: string;
}

export interface WorkOSUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  profilePictureUrl: string | null;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  user: WorkOSUser;
  /** Epoch ms, read from the access token's `exp`. */
  expiresAt: number | null;
}

export class AuthError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  // Fields declared and assigned explicitly, not as constructor parameter
  // properties: Node runs .ts directly for tests in strip-only mode, which can
  // remove types but cannot emit the assignments a parameter property implies.
  constructor(message: string, code: string, retryable: boolean) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Decode a JWT payload without verifying. Verification is the server's job. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString());
  } catch { return null; }
}

const expiryOf = (accessToken: string): number | null => {
  const exp = decodeJwtPayload(accessToken)?.['exp'];
  return typeof exp === 'number' ? exp * 1000 : null;
};

export function buildAuthorizeUrl(
  cfg: WorkOSConfig,
  pkce: Pkce,
  redirectUri: string,
  opts: { provider?: string; loginHint?: string } = {},
): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    // 'authkit' presents the hosted page with every enabled method — social,
    // password, magic auth — rather than jumping to one provider.
    provider: opts.provider ?? 'authkit',
    code_challenge: pkce.challenge,
    code_challenge_method: pkce.method,
    state: pkce.state,
  });
  if (opts.loginHint) q.set('login_hint', opts.loginHint);
  return `${cfg.apiBase ?? API}/user_management/authorize?${q}`;
}

function toUser(raw: Record<string, unknown>): WorkOSUser {
  return {
    id: String(raw['id'] ?? ''),
    email: String(raw['email'] ?? ''),
    firstName: (raw['first_name'] as string | null) ?? null,
    lastName: (raw['last_name'] as string | null) ?? null,
    profilePictureUrl: (raw['profile_picture_url'] as string | null) ?? null,
  };
}

async function authenticate(cfg: WorkOSConfig, body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${cfg.apiBase ?? API}/user_management/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, ...body }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, string>;

  if (!res.ok) {
    const code = json['error'] ?? `http_${res.status}`;
    // 5xx and network faults are worth retrying; a rejected grant is not —
    // replaying a consumed authorization code will never start working.
    const retryable = res.status >= 500;
    throw new AuthError(json['error_description'] ?? code, code, retryable);
  }

  const accessToken = json['access_token'] ?? '';
  return {
    accessToken,
    refreshToken: json['refresh_token'] ?? '',
    user: toUser((json as unknown as { user: Record<string, unknown> }).user ?? {}),
    expiresAt: expiryOf(accessToken),
  };
}

export const exchangeCode = (cfg: WorkOSConfig, a: { code: string; verifier: string }) =>
  authenticate(cfg, { grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier });

export const refreshTokens = (cfg: WorkOSConfig, refreshToken: string) =>
  authenticate(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken });
