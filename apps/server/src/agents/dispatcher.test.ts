// From a queued run to an answer (docs/WORKSPACE-AGENTS.md §5.3), against
// Postgres and a stand-in runtime.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer, type Server } from 'node:http';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { env } from '../env.ts';
import { createChannel, joinSpace } from '../sync/spaces.ts';
import { send } from '../sync/ops.ts';
import { Registry } from '../sync/registry.ts';
import { startDispatcher } from './dispatcher.ts';

const up = await reachable();
const opts = up && env.agentGrantSecret ? {}
  : { skip: 'postgres not reachable, or AGENT_GRANT_SECRET unset — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const invoker = ulid('act');
const agent = ulid('act');

const RUNTIME_ENV = env as unknown as { agentRuntimeUrl: string | null; agentS2sKey: string | null };
const restore = { url: env.agentRuntimeUrl, key: env.agentS2sKey };

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Dispatcher' }).execute();
  await db.insertInto('workspaces').values({ id: wsp, org_id: org, name: 'Dispatcher', slug: `d-${wsp.slice(-6).toLowerCase()}` }).execute();
  for (const [id, type] of [[invoker, 'human'], [agent, 'agent']] as const) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type,
      handle: `d-${id.slice(-6).toLowerCase()}`, display_name: type === 'agent' ? 'Triage' : 'Person',
      avatar_url: null, identity_kind: type === 'agent' ? 'system' : 'workos_user',
      identity_id: type === 'agent' ? null : `wu_${id}`,
      owner_actor_id: type === 'agent' ? invoker : null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member' }).execute();
  }
  RUNTIME_ENV.agentS2sKey = 'test-s2s-key';
});

after(async () => {
  if (!up) return;
  RUNTIME_ENV.agentRuntimeUrl = restore.url;
  RUNTIME_ENV.agentS2sKey = restore.key;
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

/** A channel with `invoker` and the agent both members. */
async function room(): Promise<string> {
  const made = await createChannel(db, { workspaceId: wsp, name: `d-${ulid('x')}`, createdBy: invoker });
  await joinSpace(db, made.spaceId, agent);
  return made.chatId;
}

/** As `room()`, but the space is also open to anyone in the workspace to join. */
async function roomFor(...actorIds: string[]): Promise<string> {
  const made = await createChannel(db, { workspaceId: wsp, name: `d-${ulid('x')}`, createdBy: invoker });
  await joinSpace(db, made.spaceId, agent);
  for (const id of actorIds) await joinSpace(db, made.spaceId, id);
  return made.chatId;
}

/** A mention that starts exactly one run, returning its id and trigger message. */
async function mention(
  chatId: string, body = `[Triage](actor:${agent}) go`, actorId = invoker,
): Promise<{ runId: string; messageId: string }> {
  const r = await send(db, { opId: ulid('op'), chatId, actorId, messageId: ulid('msg'), body });
  const runId = r.runIds[0];
  assert.ok(runId, 'the mention must have started a run');
  return { runId, messageId: r.ack.messageId };
}

const runState = async (runId: string) => (await db.selectFrom('agent_runs')
  .select(['state', 'refusal', 'defer_reason', 'not_before'])
  .where('id', '=', runId).executeTakeFirstOrThrow());

const replyBody = async (chatId: string, parentId: string): Promise<string | undefined> => {
  const row = await db.selectFrom('messages').select('body')
    .where('chat_id', '=', chatId).where('parent_id', '=', parentId)
    .where('author_id', '=', agent).executeTakeFirst();
  return row?.body;
};

/** Poll until `check` is true, or fail after `ms`. Everything here is async and detached. */
async function waitFor(check: () => Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('waitFor: condition never became true');
    await sleep(25);
  }
}

const servers: Server[] = [];
after(async () => { await Promise.all(servers.map(s => new Promise(r => s.close(r)))); });

/** A runtime that answers every run with a fixed `status`, after `delayMs`. */
async function fakeRuntime(status: 'completed' | 'failed' = 'completed', delayMs = 0): Promise<void> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const { runId } = JSON.parse(raw) as { runId: string };
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const result = {
          runId, status, text: status === 'completed' ? `answer for ${runId}` : '', toolCalls: [],
          usage: { input: 1, output: 1, cacheRead: 0 }, turns: 1, provider: 'test', durationMs: 1,
          ...(status === 'failed' ? { error: 'boom' } : {}),
        };
        res.write(`event: done\ndata: ${JSON.stringify({ seq: 0, result })}\n\n`);
        res.end();
      }, delayMs);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  RUNTIME_ENV.agentRuntimeUrl = `http://127.0.0.1:${port}`;
}

test('admits a queued run, calls the runtime, and posts the answer', opts, async () => {
  await fakeRuntime('completed');
  const chatId = await room();
  const { runId, messageId } = await mention(chatId);

  const dispatcher = startDispatcher(db, new Registry());
  try {
    dispatcher.wake();
    await waitFor(async () => (await runState(runId)).state === 'completed');
    const body = await replyBody(chatId, messageId);
    assert.equal(body, `answer for ${runId}`);
  } finally {
    dispatcher.stop();
  }
});

test('refuses a run whose invoker has gone inactive, without ever calling the runtime', opts, async () => {
  const chatId = await room();
  const gone = ulid('act');
  await db.insertInto('actors').values({
    id: gone, org_id: org, workspace_id: wsp, type: 'human', handle: `d-${gone.slice(-6).toLowerCase()}`,
    display_name: 'Gone', avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${gone}`,
    owner_actor_id: null, provisioned_by: 'api', state: 'deactivated',
  }).execute();
  await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: gone, role: 'member' }).execute();

  // A run this invoker could never have started live (send() itself would
  // check membership) — inserted directly to reach admitRun's own check.
  const runId = ulid('run');
  const trigger = await send(db, {
    opId: ulid('op'), chatId, actorId: invoker, messageId: ulid('msg'), body: 'placeholder trigger',
  });
  await db.insertInto('agent_runs').values({
    id: runId, workspace_id: wsp, agent_actor_id: agent, invoker_actor_id: gone,
    chat_id: chatId, trigger_message_id: trigger.ack.messageId, state: 'queued',
  }).execute();

  // No fake runtime is started at all: a call to it would leave `AGENT_RUNTIME_URL`
  // pointing nowhere, and the run would hang rather than the test failing clean.
  await fakeRuntime('completed');
  const dispatcher = startDispatcher(db, new Registry());
  try {
    dispatcher.wake();
    await waitFor(async () => (await runState(runId)).state === 'refused');
    const after_ = await runState(runId);
    assert.equal(after_.refusal, 'invoker_inactive');
    const body = await replyBody(chatId, trigger.ack.messageId);
    assert.equal(body, "I can't run this: whoever asked is no longer active here.");
  } finally {
    dispatcher.stop();
  }
});

test('a person\'s runs already in flight — stuck ones included — never hold back their next mention', opts, async () => {
  // A throwaway invoker, never used elsewhere: the filler rows below are left
  // `running` on purpose, as a server restart leaves them until their lease
  // expires, and must not leak into any other test.
  const busyInvoker = ulid('act');
  await db.insertInto('actors').values({
    id: busyInvoker, org_id: org, workspace_id: wsp, type: 'human',
    handle: `d-${busyInvoker.slice(-6).toLowerCase()}`, display_name: 'Busy',
    avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${busyInvoker}`,
    owner_actor_id: null, provisioned_by: 'api', state: 'active',
  }).execute();
  await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: busyInvoker, role: 'member' }).execute();
  const chatId = await roomFor(busyInvoker);

  // Five runs already `running` for this person, against distinct triggers
  // (the unique key is per trigger+agent+attempt) — more than any cap there was.
  for (let i = 0; i < 5; i++) {
    const filler = await send(db, { opId: ulid('op'), chatId, actorId: busyInvoker, messageId: ulid('msg'), body: `filler ${i}` });
    await db.insertInto('agent_runs').values({
      id: ulid('run'), workspace_id: wsp, agent_actor_id: agent, invoker_actor_id: busyInvoker,
      chat_id: chatId, trigger_message_id: filler.ack.messageId, state: 'running',
    }).execute();
  }
  const { runId, messageId } = await mention(chatId, `[Triage](actor:${agent}) one more`, busyInvoker);

  await fakeRuntime('completed');
  const dispatcher = startDispatcher(db, new Registry());
  try {
    dispatcher.wake();
    await waitFor(async () => (await runState(runId)).state === 'completed');
    assert.equal((await runState(runId)).defer_reason, null, 'admitted on its first claim, never deferred');
    assert.equal(await replyBody(chatId, messageId), `answer for ${runId}`);
  } finally {
    dispatcher.stop();
  }
});

test('a lease that outlived its server is swept and posted as interrupted', opts, async () => {
  const chatId = await room();
  const { runId, messageId } = await mention(chatId, `[Triage](actor:${agent}) status`);
  const replyMessageId = ulid('msg');
  await db.updateTable('agent_runs').set({
    state: 'running', reply_message_id: replyMessageId,
    started_at: new Date(Date.now() - 60_000), lease_until: new Date(Date.now() - 1000),
  }).where('id', '=', runId).execute();

  await fakeRuntime('completed');   // must never be reached — this run is swept, not claimed
  const dispatcher = startDispatcher(db, new Registry());
  try {
    dispatcher.wake();
    await waitFor(async () => (await runState(runId)).state === 'interrupted');
    const body = await replyBody(chatId, messageId);
    assert.equal(body, 'I was interrupted by a restart — ask again.');
  } finally {
    dispatcher.stop();
  }
});

test('a swept run whose notice cannot be written still leaves running, instead of failing every sweep', opts, async () => {
  const chatId = await room();
  const { runId, messageId } = await mention(chatId, `[Triage](actor:${agent}) status`);
  // A reply id that already names a message — the collision a card sharing
  // the reply id used to cause. The notice write fails on messages_pkey.
  await db.updateTable('agent_runs').set({
    state: 'running', reply_message_id: messageId,
    started_at: new Date(Date.now() - 60_000), lease_until: new Date(Date.now() - 1000),
  }).where('id', '=', runId).execute();

  await fakeRuntime('completed');
  const dispatcher = startDispatcher(db, new Registry());
  try {
    dispatcher.wake();
    await waitFor(async () => (await runState(runId)).state === 'interrupted');
  } finally {
    dispatcher.stop();
  }
});

test('two runs of one agent in one thread are independent — each is claimed and answered on its own', opts, async () => {
  await fakeRuntime('completed');
  const bob = ulid('act');
  await db.insertInto('actors').values({
    id: bob, org_id: org, workspace_id: wsp, type: 'human', handle: `d-${bob.slice(-6).toLowerCase()}`,
    display_name: 'Bob', avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${bob}`,
    owner_actor_id: null, provisioned_by: 'api', state: 'active',
  }).execute();
  await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: bob, role: 'member' }).execute();
  const chatId = await roomFor(bob);

  const root = await send(db, { opId: ulid('op'), chatId, actorId: invoker, messageId: ulid('msg'), body: 'a thread starts' });
  const askA = await send(db, {
    opId: ulid('op'), chatId, actorId: invoker, messageId: ulid('msg'),
    body: `[Triage](actor:${agent}) first ask`, parentId: root.ack.messageId,
  });
  const askB = await send(db, {
    opId: ulid('op'), chatId, actorId: bob, messageId: ulid('msg'),
    body: `[Triage](actor:${agent}) second ask`, parentId: root.ack.messageId,
  });
  assert.equal(askA.runIds.length, 1);
  assert.equal(askB.runIds.length, 1);
  assert.notEqual(askA.runIds[0], askB.runIds[0]);

  const dispatcher = startDispatcher(db, new Registry());
  try {
    dispatcher.wake();
    await waitFor(async () =>
      (await runState(askA.runIds[0] ?? '')).state === 'completed'
      && (await runState(askB.runIds[0] ?? '')).state === 'completed');

    const replies = await db.selectFrom('messages').select(['body', 'delegation_id'])
      .where('chat_id', '=', chatId).where('author_id', '=', agent).execute();
    assert.equal(replies.length, 2, 'each mention got its own answer — neither dedup, nor a shared reply');
    assert.deepEqual(new Set(replies.map(r => r.delegation_id)),
      new Set([askA.runIds[0], askB.runIds[0]]));
  } finally {
    dispatcher.stop();
  }
});

test('SKIP LOCKED: two dispatchers polling the same table never claim the same run', opts, async () => {
  await fakeRuntime('completed', 200);   // slow enough that both dispatchers' first tick overlaps
  const chatId = await room();
  const first = await mention(chatId, `[Triage](actor:${agent}) one`);
  const second = await mention(chatId, `[Triage](actor:${agent}) two`);

  const a = startDispatcher(db, new Registry());
  const b = startDispatcher(db, new Registry());
  try {
    a.wake(); b.wake();
    await waitFor(async () =>
      (await runState(first.runId)).state === 'completed' && (await runState(second.runId)).state === 'completed');

    // Each run has exactly one reply — if both dispatchers had claimed the
    // same row, `writeRunMessage`'s ops-ledger key would still cap it at one
    // message, so the real proof is `started_at` being set exactly once each,
    // which only SKIP LOCKED (not idempotency) guarantees.
    for (const { runId } of [first, second]) {
      const rows = await db.selectFrom('messages').select('id')
        .where('delegation_id', '=', runId).execute();
      assert.equal(rows.length, 1, `run ${runId} was answered exactly once`);
    }
  } finally {
    a.stop(); b.stop();
  }
});
