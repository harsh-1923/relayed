// The tool-call grant (docs/WORKSPACE-AGENTS.md §5.5).
//
// No database: this is a pure sign/verify roundtrip, and everything worth
// proving is in what verification refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { ulid } from '../db/ulid.ts';
import { env } from '../env.ts';
import { signGrant, verifyGrant, GrantError, type GrantClaims } from './grant.ts';

const opts = env.agentGrantSecret ? {} : { skip: 'AGENT_GRANT_SECRET is not set' };

const claims = (): GrantClaims => ({
  invokerActorId: ulid('act'), agentActorId: ulid('act'), runId: ulid('run'), chatId: ulid('cht'),
});

test('a grant verifies back to exactly the claims it was signed with', opts, async () => {
  const c = claims();
  const token = await signGrant(c);
  const verified = await verifyGrant(token, c.runId);
  assert.deepEqual(verified, c);
});

test('a grant names a different run than the one it is presented for', opts, async () => {
  const c = claims();
  const token = await signGrant(c);
  await assert.rejects(verifyGrant(token, ulid('run')), (err: unknown) => {
    assert.ok(err instanceof GrantError);
    assert.equal(err.reason, 'run_mismatch');
    return true;
  });
});

test('an expired grant is rejected, distinctly from a malformed one', async () => {
  const c = claims();
  if (!env.agentGrantSecret) return;
  const token = await new SignJWT({ act: { sub: c.agentActorId }, run: c.runId, chat: c.chatId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.invokerActorId)
    .setAudience('relayed-agent-tools')
    .setIssuedAt()
    .setExpirationTime('-1s')
    .sign(new TextEncoder().encode(env.agentGrantSecret));
  await assert.rejects(verifyGrant(token, c.runId), (err: unknown) => {
    assert.ok(err instanceof GrantError);
    assert.equal(err.reason, 'expired');
    return true;
  });
});

test('a grant signed for a different audience is rejected', opts, async () => {
  const c = claims();
  const token = await new SignJWT({ act: { sub: c.agentActorId }, run: c.runId, chat: c.chatId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.invokerActorId)
    .setAudience('some-other-audience')
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(env.agentGrantSecret ?? ''));
  await assert.rejects(verifyGrant(token, c.runId), (err: unknown) => {
    assert.ok(err instanceof GrantError);
    assert.equal(err.reason, 'wrong_audience');
    return true;
  });
});

test('a token signed with a different secret is rejected as malformed', opts, async () => {
  const c = claims();
  const token = await new SignJWT({ act: { sub: c.agentActorId }, run: c.runId, chat: c.chatId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.invokerActorId)
    .setAudience('relayed-agent-tools')
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode('a-completely-different-secret'));
  await assert.rejects(verifyGrant(token, c.runId), (err: unknown) => {
    assert.ok(err instanceof GrantError);
    assert.equal(err.reason, 'malformed');
    return true;
  });
});

test('nonsense is rejected as malformed, not thrown as something unhandled', opts, async () => {
  await assert.rejects(verifyGrant('not.a.jwt', ulid('run')), (err: unknown) => {
    assert.ok(err instanceof GrantError);
    assert.equal(err.reason, 'malformed');
    return true;
  });
});
