// The tool-call grant (docs/WORKSPACE-AGENTS.md §5.5; the plan's D4).
//
// The only credential the runtime holds for one run, and it only works for
// that run. HS256 with the RFC 8693 actor-delegation claim shape `DESIGN.md`
// §6.4 already chose: `sub` is who the call acts for, `act.sub` is who is
// acting. Signed with `AGENT_GRANT_SECRET` — a SEPARATE secret and audience
// from session tokens, so neither can be presented as the other, and never
// read in `apps/agent` (invariant 75's sibling: only the server signs it).
//
// The grant proves the caller was handed this run; the broker's own row
// lookup (step 5) proves the run is still running. Together, not either
// alone — the row alone would let anything on the internal network that
// guesses a run id call tools for it, and the signature alone could not be
// revoked before it expires.
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../env.ts';

const AUDIENCE = 'relayed-agent-tools';

/** How long a grant is valid. Comfortably above any one run's timeout. */
const GRANT_TTL_SEC = 30 * 60;

export interface GrantClaims {
  /** The invoker: whose authority a tool call spends. */
  invokerActorId: string;
  /** The agent: who is acting. */
  agentActorId: string;
  runId: string;
  chatId: string;
}

/** A grant that failed to verify, and why — never the secret, never the token. */
export class GrantError extends Error {
  readonly reason: 'malformed' | 'wrong_audience' | 'expired' | 'run_mismatch';
  constructor(reason: GrantError['reason']) {
    super(`grant rejected: ${reason}`);
    this.name = 'GrantError';
    this.reason = reason;
  }
}

function secretKey(): Uint8Array {
  if (!env.agentGrantSecret) throw new Error('AGENT_GRANT_SECRET is not set');
  return new TextEncoder().encode(env.agentGrantSecret);
}

/** Sign a grant for one run. Called once, at claim, before the runtime is called. */
export async function signGrant(claims: GrantClaims): Promise<string> {
  return new SignJWT({
    act: { sub: claims.agentActorId },
    run: claims.runId,
    chat: claims.chatId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.invokerActorId)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${GRANT_TTL_SEC}s`)
    .sign(secretKey());
}

/**
 * Verify a grant, and that it names THIS run — the broker's step 1 (§5.5).
 *
 * `expectedRunId` is checked here rather than left to the caller, because a
 * grant that verifies but names a different run is exactly the forged-caller
 * case the audience and signature exist to catch, and a caller that forgot to
 * compare `run` would accept it.
 */
export async function verifyGrant(token: string, expectedRunId: string): Promise<GrantClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, secretKey(), { audience: AUDIENCE, algorithms: ['HS256'] }));
  } catch (err) {
    // jose throws a distinct error for an expired token; everything else —
    // bad signature, wrong audience, malformed JWT — is one bucket, because
    // none of them is actionable differently from the caller's side.
    const code = (err as { code?: string }).code;
    throw new GrantError(code === 'ERR_JWT_EXPIRED' ? 'expired'
      : code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' ? 'wrong_audience' : 'malformed');
  }
  const act = payload['act'];
  const invokerActorId = payload['sub'];
  const agentActorId = typeof act === 'object' && act !== null ? (act as { sub?: unknown }).sub : undefined;
  if (typeof invokerActorId !== 'string' || typeof agentActorId !== 'string'
      || typeof payload['run'] !== 'string' || typeof payload['chat'] !== 'string') {
    throw new GrantError('malformed');
  }
  if (payload['run'] !== expectedRunId) throw new GrantError('run_mismatch');
  return { invokerActorId, agentActorId, runId: payload['run'], chatId: payload['chat'] };
}
