// Our session tokens. Signed with Ed25519 so any service that only *verifies*
// (the agents runtime, Phase 6) holds the public key and cannot mint.
import { SignJWT, jwtVerify, importPKCS8, importSPKI, type KeyObject, type CryptoKey } from 'jose';
import { createHash, createPublicKey, randomBytes, type KeyObject as NodeKeyObject } from 'node:crypto';
import { env } from '../env.ts';

const ISSUER = 'relayed';
const AUDIENCE = 'relayed-client';

// EdDSA signs with the PRIVATE key and verifies with the PUBLIC one. Reusing
// the private key for verification throws — which is the point of asymmetric
// signing: a service that only verifies can never mint.
let privKey: CryptoKey | KeyObject | null = null;
let pubKey: CryptoKey | KeyObject | null = null;

async function signingKey() {
  if (privKey) return privKey;
  if (!env.sessionPrivateKey) throw new Error('SESSION_PRIVATE_KEY is not set — run `pnpm keygen`');
  privKey = await importPKCS8(env.sessionPrivateKey.replaceAll('\\n', '\n'), 'EdDSA');
  return privKey;
}

async function verifyKey() {
  if (pubKey) return pubKey;
  if (env.sessionPublicKey) {
    pubKey = await importSPKI(env.sessionPublicKey.replaceAll('\\n', '\n'), 'EdDSA');
    return pubKey;
  }
  // Derive from the private key when only that is configured, so a service
  // holding both does not need the public key spelled out separately.
  const priv = await signingKey();
  // jose's KeyObject and node:crypto's are structurally distinct types for
  // the same runtime object.
  pubKey = createPublicKey(priv as unknown as NodeKeyObject) as unknown as KeyObject;
  return pubKey;
}

export interface SessionClaims {
  /** actor_id — the ONLY identity the rest of the system knows (§5). */
  actorId: string;
  workspaceId: string;
  orgId: string;
  /** Which install. A WorkOS token cannot express this. */
  deviceId: string;
  sessionId: string;
}

export async function signAccessToken(c: SessionClaims): Promise<string> {
  return new SignJWT({ wsp: c.workspaceId, org: c.orgId, dev: c.deviceId, sid: c.sessionId })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(c.actorId)
    .setIssuedAt().setExpirationTime(`${env.accessTokenTtlSec}s`)
    .sign(await signingKey());
}

export async function verifyAccessToken(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, await verifyKey(), {
    issuer: ISSUER, audience: AUDIENCE, algorithms: ['EdDSA'],
  });
  return {
    actorId: String(payload.sub),
    workspaceId: String(payload['wsp']),
    orgId: String(payload['org']),
    deviceId: String(payload['dev']),
    sessionId: String(payload['sid']),
  };
}

/**
 * Refresh tokens are opaque random strings, not JWTs. A JWT would be
 * self-validating and therefore impossible to revoke before it expires; an
 * opaque token is only valid because a row says so, which is what makes
 * "sign out this device" a delete.
 */
export const newRefreshToken = (): string => randomBytes(32).toString('base64url');

/** Only the hash is stored — a database leak must not yield live credentials. */
export const hashRefreshToken = (t: string): string =>
  createHash('sha256').update(t).digest('base64url');
