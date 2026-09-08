// PKCE (RFC 7636). Mandatory here: a desktop app is a public OAuth client, and
// a client secret shipped in an Electron bundle is trivially extractable from
// the asar (PHASE-1-IDENTITY.md §6).
import { createHash, randomBytes } from 'node:crypto';

const b64url = (b: Buffer): string =>
  b.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256';
  state: string;
}

export function createPkce(): Pkce {
  // 32 random bytes → 43 base64url chars, the RFC 7636 minimum.
  const verifier = b64url(randomBytes(32));
  return {
    verifier,
    challenge: b64url(createHash('sha256').update(verifier).digest()),
    method: 'S256',
    // `state` is CSRF protection for the callback, independent of PKCE: it is
    // what proves the redirect we receive belongs to the request we started.
    state: b64url(randomBytes(16)),
  };
}
