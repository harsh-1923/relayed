// Writing what a run leaves behind (docs/WORKSPACE-AGENTS.md §5.7, §5.8),
// against Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { createChannel, joinSpace } from '../sync/spaces.ts';
import { send } from '../sync/ops.ts';
import { deliverReply, type FinishedRun } from './reply.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const invoker = ulid('act');
const agent = ulid('act');

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Reply' }).execute();
  await db.insertInto('workspaces').values({ id: wsp, org_id: org, name: 'Reply', slug: `r-${wsp.slice(-6).toLowerCase()}` }).execute();
  for (const [id, type] of [[invoker, 'human'], [agent, 'agent']] as const) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type,
      handle: `r-${id.slice(-6).toLowerCase()}`, display_name: type === 'agent' ? 'Triage' : 'Person',
      avatar_url: null, identity_kind: type === 'agent' ? 'system' : 'workos_user',
      identity_id: type === 'agent' ? null : `wu_${id}`,
      owner_actor_id: type === 'agent' ? invoker : null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member' }).execute();
  }
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

/** A channel with both members, and one message in it to act as a trigger. */
async function setup(runState: 'running' | 'queued' | 'cancelled' = 'running'): Promise<FinishedRun> {
  const made = await createChannel(db, { workspaceId: wsp, name: `r-${ulid('x')}`, createdBy: invoker });
  await joinSpace(db, made.spaceId, agent);
  const triggered = await send(db, {
    opId: ulid('op'), chatId: made.chatId, actorId: invoker, messageId: ulid('msg'),
    body: `[Triage](actor:${agent}) go`, parentId: null,
  });
  // `send` itself starts the run now (ops.ts §5.2) — use that row rather than
  // inserting a second one, which would collide on the trigger/agent/attempt key.
  const runId = triggered.runIds[0];
  assert.ok(runId, 'the mention above must have started exactly one run');
  await db.updateTable('agent_runs').set({ state: runState }).where('id', '=', runId).execute();
  return {
    id: runId, chatId: made.chatId, agentActorId: agent, invokerActorId: invoker,
    replyMessageId: ulid('msg'), replyParentId: triggered.ack.messageId,
  };
}

test('a completed run posts markdown and a tool part, on behalf of the invoker', opts, async () => {
  const run = await setup('running');
  // What the broker recorded: one call that ran, and one that stopped for
  // access. Only the first is a line in the reply — the card covers the second,
  // and a search (never recorded) has none at all.
  await db.insertInto('agent_tool_calls').values([
    { run_id: run.id, tool_call_id: 'call_ran', toolkit: 'linear', tool: 'LINEAR_CREATE_ISSUE', effect: 'write', outcome: 'ok', duration_ms: 120 },
    { run_id: run.id, tool_call_id: 'call_stopped', toolkit: 'linear', tool: 'LINEAR_DELETE_ISSUE', effect: 'destructive', outcome: 'permission_required', duration_ms: 0 },
  ]).execute();
  const written = await deliverReply(db, run, {
    state: 'completed',
    result: {
      runId: run.id, status: 'completed', text: 'Done — filed as LIN-42.',
      // The runtime's own list only knows the two names every run is given.
      toolCalls: [{ name: 'find_tools', ok: true, ms: 900 }, { name: 'call_tool', ok: true, ms: 120 }],
      usage: { input: 10, output: 5, cacheRead: 0 }, turns: 1, provider: 'anthropic', durationMs: 500,
    },
  });
  assert.ok(written.posted);

  const row = await db.selectFrom('messages')
    .select(['author_id', 'on_behalf_of_actor_id', 'delegation_id', 'parent_id', 'parts'])
    .where('id', '=', run.replyMessageId).executeTakeFirstOrThrow();
  assert.equal(row.author_id, agent);
  assert.equal(row.on_behalf_of_actor_id, invoker);
  assert.equal(row.delegation_id, run.id);
  assert.equal(row.parent_id, run.replyParentId);
  const parts = row.parts as unknown as { kind: string; name?: string; ok?: boolean; ms?: number }[];
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.kind, 'markdown');
  assert.deepEqual({ kind: parts[1]?.kind, name: parts[1]?.name, ok: parts[1]?.ok, ms: parts[1]?.ms },
    { kind: 'tool', name: 'LINEAR_CREATE_ISSUE', ok: true, ms: 120 },
    'the tool that ran, from the audit — no find_tools, no call_tool, no line for the access stop');

  const after_ = await db.selectFrom('agent_runs').select('state').where('id', '=', run.id).executeTakeFirstOrThrow();
  assert.equal(after_.state, 'completed');
});

test('STOP WINS: an answer arriving for an already-cancelled run posts nothing', opts, async () => {
  const run = await setup('cancelled');   // as if /stop had already landed
  const written = await deliverReply(db, run, {
    state: 'completed',
    result: { runId: run.id, status: 'completed', text: 'too late', toolCalls: [],
              usage: { input: 0, output: 0, cacheRead: 0 }, turns: 1, provider: 'x', durationMs: 1 },
  });
  assert.equal(written.posted, false, 'the run was already finished; the late answer must not land');

  const row = await db.selectFrom('messages').select('id').where('id', '=', run.replyMessageId).executeTakeFirst();
  assert.equal(row, undefined, 'no message was ever written for the suppressed answer');

  const after_ = await db.selectFrom('agent_runs').select('state').where('id', '=', run.id).executeTakeFirstOrThrow();
  assert.equal(after_.state, 'cancelled', 'the suppressed write must not relabel the state either');
});

test('a queued run that is stopped is transitioned AND gets the notice — not just one of the two', opts, async () => {
  const run = await setup('queued');   // never claimed
  const written = await deliverReply(db, run, { state: 'cancelled', by: 'Bob' });
  assert.ok(written.posted, 'a queued-or-deferred run is stoppable without the runtime ever hearing of it (§5.8)');

  const row = await db.selectFrom('messages').select('body').where('id', '=', run.replyMessageId).executeTakeFirstOrThrow();
  assert.equal(row.body, 'Stopped by Bob.');

  const after_ = await db.selectFrom('agent_runs').select('state').where('id', '=', run.id).executeTakeFirstOrThrow();
  assert.equal(after_.state, 'cancelled');
});

test('calling deliverReply twice for one run writes exactly one message', opts, async () => {
  const run = await setup('running');
  const first = await deliverReply(db, run, { state: 'timeout' });
  const second = await deliverReply(db, run, { state: 'timeout' });
  assert.ok(first.posted && second.posted);
  assert.deepEqual(first, second, 'the ops ledger hands back the same result rather than writing again');

  const rows = await db.selectFrom('messages').select('id').where('id', '=', run.replyMessageId).execute();
  assert.equal(rows.length, 1);
});

test('each non-answer outcome posts its own one-line notice', opts, async () => {
  const cases: { run: () => Promise<FinishedRun>; outcome: Parameters<typeof deliverReply>[2]; text: string }[] = [
    { run: () => setup('running'), outcome: { state: 'refused', code: 'not_a_member' },
      text: "I can't run here: I'm no longer a member of this space." },
    { run: () => setup('running'), outcome: { state: 'failed', reason: 'runtime_unavailable' },
      text: "I couldn't finish: the model provider is unavailable." },
    { run: () => setup('running'), outcome: { state: 'timeout' },
      text: 'I ran out of time before finishing.' },
    { run: () => setup('running'), outcome: { state: 'interrupted' },
      text: 'I was interrupted by a restart — ask again.' },
  ];
  for (const c of cases) {
    const run = await c.run();
    const written = await deliverReply(db, run, c.outcome);
    assert.ok(written.posted);
    const row = await db.selectFrom('messages').select('body').where('id', '=', run.replyMessageId).executeTakeFirstOrThrow();
    assert.equal(row.body, c.text);
  }
});
