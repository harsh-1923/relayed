// The access card (docs/WORKSPACE-AGENTS.md §7.4), against Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { createChannel, joinSpace } from '../sync/spaces.ts';
import { send } from '../sync/ops.ts';
import type { FanoutResult } from '../sync/fanout.ts';
import { raiseAccessRequest, grantPermission, resolveAccessRequests } from './access.ts';
import { rerunIfReady } from './rerun.ts';
import { onRunEnd } from './checkpoints.ts';
import { Registry } from '../sync/registry.ts';
import { claimReplyMessageId } from './dispatcher.ts';
import { deliverReply } from './reply.ts';
import { removeTestToolkits, sweepTestToolkits } from '../db/test-toolkits.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const invoker = ulid('act');
const agent = ulid('act');
const toolkitSlug = `acc${ulid('t').slice(-8).toLowerCase()}`;

const deliver = async (): Promise<FanoutResult> => ({ audience: 0, delivered: 0, withheld: 0, dropped: 0 });

before(async () => {
  if (!up) return;
  await sweepTestToolkits(db);
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Access' }).execute();
  await db.insertInto('workspaces').values({ id: wsp, org_id: org, name: 'Access', slug: `a-${wsp.slice(-6).toLowerCase()}` }).execute();
  for (const [id, type] of [[invoker, 'human'], [agent, 'agent']] as const) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type,
      handle: `a-${id.slice(-6).toLowerCase()}`, display_name: type === 'agent' ? 'Triage' : 'Person',
      avatar_url: null, identity_kind: type === 'agent' ? 'system' : 'workos_user',
      identity_id: type === 'agent' ? null : `wu_${id}`,
      owner_actor_id: type === 'agent' ? invoker : null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member' }).execute();
  }
  await db.insertInto('toolkits').values({
    slug: toolkitSlug, name: 'Hub', description: '', logo_url: null, auth_scheme: 'OAUTH2',
    auth_config_id: `ac_${toolkitSlug}`, auth_managed_by: 'composio', auth_guide_url: null, enabled: true,
    refreshed_at: new Date(),
  }).execute();
});

after(async () => {
  if (!up) return;
  // First, and on its own: a toolkit left enabled breaks every real session.
  await removeTestToolkits(db, [toolkitSlug]);
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

/** A mention that started one run, claimed and running, with its reply id chosen as the dispatcher does. */
async function runningRun() {
  const made = await createChannel(db, { workspaceId: wsp, name: `a-${ulid('x')}`, createdBy: invoker });
  await joinSpace(db, made.spaceId, agent);
  const triggered = await send(db, {
    opId: ulid('op'), chatId: made.chatId, actorId: invoker, messageId: ulid('msg'),
    body: `[Triage](actor:${agent}) look at issue 445`, parentId: null,
  });
  const runId = triggered.runIds[0];
  assert.ok(runId, 'the mention must have started a run');
  await db.updateTable('agent_runs').set({ state: 'running' }).where('id', '=', runId).execute();
  const replyMessageId = await claimReplyMessageId(db, runId);
  return { runId, chatId: made.chatId, triggerId: triggered.ack.messageId, replyMessageId };
}

test('a run that raises a card and then answers posts both, and ends completed', opts, async () => {
  const run = await runningRun();

  await raiseAccessRequest(db, deliver, {
    runId: run.runId, invokerActorId: invoker, agentActorId: agent, toolkit: 'github', effect: 'write',
  });
  const card = await db.selectFrom('access_requests').select('message_id')
    .where('run_id', '=', run.runId).executeTakeFirstOrThrow();
  assert.notEqual(card.message_id, run.replyMessageId, 'the card must not take the id reserved for the answer');

  // The model, told a card was posted, says so and finishes — the write that
  // used to collide with the card on messages_pkey.
  const written = await deliverReply(db, {
    id: run.runId, chatId: run.chatId, agentActorId: agent, invokerActorId: invoker,
    replyMessageId: run.replyMessageId, replyParentId: run.triggerId,
  }, {
    state: 'completed',
    result: {
      runId: run.runId, status: 'completed', text: 'I need access to your GitHub first.', toolCalls: [],
      usage: { input: 1, output: 1, cacheRead: 0 }, turns: 1, provider: 'test', durationMs: 1,
    },
  });
  assert.equal(written.posted, true);

  const messages = await db.selectFrom('messages').select('id')
    .where('chat_id', '=', run.chatId).where('author_id', '=', agent).execute();
  assert.deepEqual(new Set(messages.map(m => m.id)), new Set([card.message_id, run.replyMessageId]));
  const row = await db.selectFrom('agent_runs').select('state').where('id', '=', run.runId).executeTakeFirstOrThrow();
  assert.equal(row.state, 'completed');
});

// ─── Allow, and re-running what waited on it (the plan's step 7, D23, D25) ──


const permission = () => db.selectFrom('agent_permissions').select(['effect', 'revoked_at'])
  .where('invoker_actor_id', '=', invoker).where('agent_actor_id', '=', agent).where('toolkit', '=', toolkitSlug)
  .executeTakeFirst();

const card = (runId: string, effect: 'write' | 'destructive') => raiseAccessRequest(db, deliver, {
  runId, invokerActorId: invoker, agentActorId: agent, toolkit: toolkitSlug, effect,
});

async function finish(runId: string): Promise<void> {
  await db.updateTable('agent_runs').set({ state: 'completed', finished_at: new Date() }).where('id', '=', runId).execute();
}

const attempts = async (runId: string) => {
  const run = await db.selectFrom('agent_runs').select(['trigger_message_id']).where('id', '=', runId).executeTakeFirstOrThrow();
  return db.selectFrom('agent_runs').select(['attempt', 'state'])
    .where('trigger_message_id', '=', run.trigger_message_id).orderBy('attempt').execute();
};

test('Allow grants write, a destructive card grants destructive, and an ordinary Allow never takes that back', opts, async () => {
  await db.deleteFrom('agent_permissions').where('invoker_actor_id', '=', invoker).where('toolkit', '=', toolkitSlug).execute();
  const input = { invokerActorId: invoker, agentActorId: agent, toolkit: toolkitSlug, workspaceId: wsp };

  assert.equal((await grantPermission(db, new Registry(), input)).effect, 'write');
  assert.equal((await grantPermission(db, new Registry(), { ...input, effect: 'destructive' })).effect, 'destructive');
  assert.equal((await grantPermission(db, new Registry(), { ...input, effect: 'write' })).effect, 'destructive');
  assert.equal((await permission())?.effect, 'destructive');
});

test('an ordinary Allow resolves the ordinary card and leaves a destructive one open', opts, async () => {
  const run = await runningRun();
  await card(run.runId, 'write');
  const other = await runningRun();
  await card(other.runId, 'destructive');

  await resolveAccessRequests(db, deliver, { actorId: invoker, agentActorId: agent, toolkit: toolkitSlug, effect: 'write' });
  const states = await db.selectFrom('access_requests').select(['run_id', 'resolved_at'])
    .where('run_id', 'in', [run.runId, other.runId]).execute();
  assert.ok(states.find(s => s.run_id === run.runId)?.resolved_at, 'the write card resolves');
  assert.equal(states.find(s => s.run_id === other.runId)?.resolved_at, null, 'the destructive card stays open');
});

test('a card resolved after its run finished re-runs it exactly once, even when asked twice', opts, async () => {
  const run = await runningRun();
  await card(run.runId, 'write');
  await finish(run.runId);

  const runIds = await resolveAccessRequests(db, deliver, { actorId: invoker, agentActorId: agent, toolkit: toolkitSlug, effect: 'write' });
  assert.deepEqual(runIds, [run.runId]);
  const [first, second] = await Promise.all([rerunIfReady(db, run.runId), rerunIfReady(db, run.runId)]);
  assert.equal([first, second].filter(Boolean).length, 1, 'two callers at once queue one re-run');
  assert.deepEqual(await attempts(run.runId), [{ attempt: 1, state: 'completed' }, { attempt: 2, state: 'queued' }]);
});

test('a run with a second card still pending is not re-run', opts, async () => {
  const run = await runningRun();
  await card(run.runId, 'write');
  await raiseAccessRequest(db, deliver, {
    runId: run.runId, invokerActorId: invoker, agentActorId: agent, toolkit: 'github', effect: 'write',
  });
  await finish(run.runId);

  await resolveAccessRequests(db, deliver, { actorId: invoker, agentActorId: agent, toolkit: toolkitSlug, effect: 'write' });
  assert.equal(await rerunIfReady(db, run.runId), null);
  assert.equal((await attempts(run.runId)).length, 1);
});

test('a card resolved while its run is still finishing re-runs it when the run ends', opts, async () => {
  const run = await runningRun();
  await card(run.runId, 'write');

  await resolveAccessRequests(db, deliver, { actorId: invoker, agentActorId: agent, toolkit: toolkitSlug, effect: 'write' });
  assert.equal(await rerunIfReady(db, run.runId), null, 'still running: nothing yet');

  await finish(run.runId);
  await onRunEnd(db, run.runId);
  assert.deepEqual((await attempts(run.runId)).map(a => a.attempt), [1, 2]);
});

test('a run that raised no card is never re-run', opts, async () => {
  const run = await runningRun();
  await finish(run.runId);
  await onRunEnd(db, run.runId);
  assert.equal((await attempts(run.runId)).length, 1);
});
