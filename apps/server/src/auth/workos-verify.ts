// Verifies a WorkOS access token. Used ONCE, at session exchange — after that
// the client carries our token and WorkOS is off the steady-state path
// (PHASE-1-IDENTITY.md §6).
//
// Issuer and JWKS come from OIDC DISCOVERY, never from a constant. Getting
// here took three wrong guesses, so the reasoning is worth recording:
//
//   1. `https://api.workos.com`  — wrong. Not the issuer of anything.
//   2. The AuthKit domain's discovery doc — wrong, and misleading, because it
//      exists and returns a valid-looking issuer. It describes WorkOS acting
//      as an OIDC provider for third-party apps, NOT user-management tokens.
//   3. Correct: /user_management/<client_id>/.well-known/openid-configuration
//
// A useful property of (3): every client id in an environment resolves to the
// SAME canonical issuer, so this stays right even when the configured client
// id is not the environment's primary one — which is exactly the case that
// produced the last failure.
import { createRemoteJWKSet, jwtVerify, decodeJwt, decodeProtectedHeader } from 'jose';
import { env } from '../env.ts';

interface Discovery { issuer: string; jwks_uri: string }

let discovery: Promise<Discovery> | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function discover(): Promise<Discovery> {
  discovery ??= (async () => {
    const url = `https://api.workos.com/user_management/${env.workosClientId}` +
                `/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} ${url}`);
    const cfg = await res.json() as Discovery;
    if (!cfg.issuer || !cfg.jwks_uri) throw new Error('discovery returned no issuer/jwks_uri');
    return cfg;
  })();
  return discovery;
}

export interface WorkOSClaims {
  userId: string;
  organizationId: string | null;
  sessionId: string | null;
}

export async function verifyWorkOSToken(token: string): Promise<WorkOSClaims> {
  const cfg = await discover();
  // Cached, with a cooldown so a burst of unknown `kid`s cannot be used to
  // hammer the JWKS endpoint through us.
  jwks ??= createRemoteJWKSet(new URL(cfg.jwks_uri),
    { cooldownDuration: 30_000, cacheMaxAge: 600_000 });

  try {
    // `algorithms` is pinned: without it a token could assert its own
    // algorithm, which is the classic JWT confusion attack.
    const { payload } = await jwtVerify(token, jwks, {
      issuer: cfg.issuer,
      algorithms: ['RS256'],
    });
    const userId = typeof payload.sub === 'string' ? payload.sub : '';
    if (!userId) throw new Error('WorkOS token has no subject');
    return {
      userId,
      organizationId: typeof payload['org_id'] === 'string' ? payload['org_id'] : null,
      sessionId: typeof payload['sid'] === 'string' ? payload['sid'] : null,
    };
  } catch (err) {
    // A claim mismatch is otherwise opaque — "unexpected iss claim value" does
    // not say what the value WAS. Report observed vs expected (never the token,
    // never the signature) so the next mismatch is a five-second fix.
    let observed = '';
    try {
      const claims = decodeJwt(token);
      const header = decodeProtectedHeader(token);
      observed = ` [observed iss=${claims.iss} alg=${header.alg} kid=${header.kid}` +
                 ` | expected iss=${cfg.issuer}]`;
    } catch { /* not a JWT at all */ }
    throw new Error(`${(err as Error).message}${observed}`);
  }
}
