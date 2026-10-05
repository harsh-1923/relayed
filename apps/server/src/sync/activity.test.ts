// The activity register (docs/ACTIVITY.md §3, §5.1).
//
// Against fake deliveries and a fixed audience rather than Postgres: what is
// asserted is the register's own rules — seq, final ends, refresh — not who is
// in a chat, which `chatAudience` reads with the same queries fanout's tests cover.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Registry, type Delivery } from './registry.ts';
import {
  publishActivity, refreshActivity, endActivityWhere, cachedAudience, resetActivityForTest,
  TYPING_AUDIENCE_CAP, type ActivityEntry, type Audience,
} from './activity.ts';

interface Sent { actorId: string; workspaceId: string; t: string; body: Record<string, unknown> }

function harness(audienceIds: string[] = ['alice', 'bob']) {
  const sent: Sent[] = [];
  const registry = new Registry();
  const connect = (actorId: string, workspaceId = 'wsp'): void => {
    const delivery: Delivery = {
      actorId, workspaceId, backlog: 0,
      send: (t, body) => { sent.push({ actorId, workspaceId, t, body }); },
      drop: () => {},
    };
    registry.add(delivery);
  };
  const audience: Audience = async () => audienceIds;
  return { sent, registry, connect, audience };
}

const run = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  kind: 'run', key: 'run-1', chatId: 'chat-1', threadId: 'msg-1',
  actorId: 'triage', workspaceId: 'wsp', state: 'active', ...over,
});

beforeEach(() => { resetActivityForTest(); });

test('a run is sent as agent_activity, in the shape older clients read', async () => {
  const { sent, registry, connect, audience } = harness(['alice']);
  connect('alice');
  await publishActivity(registry, audience, run({ label: 'linear_search' }));
  assert.deepEqual(sent, [{
    actorId: 'alice', workspaceId: 'wsp', t: 'agent_activity',
    body: {
      chat_id: 'chat-1', thread_id: 'msg-1', agent_id: 'triage', run_id: 'run-1',
      seq: 0, state: 'running', label: 'linear_search',
    },
  }]);
});

test('every member of the audience is sent it, on every connection, and nobody else', async () => {
  const { sent, registry, connect, audience } = harness(['alice', 'bob']);
  connect('alice'); connect('alice'); connect('bob'); connect('carol');
  await publishActivity(registry, audience, run());
  assert.deepEqual(sent.map(s => s.actorId).sort(), ['alice', 'alice', 'bob']);
});

test('a connection for another workspace is not sent it', async () => {
  const { sent, registry, connect, audience } = harness(['alice']);
  connect('alice', 'other');
  await publishActivity(registry, audience, run());
  assert.equal(sent.length, 0);
});

test('seq rises per key, and keys do not share a counter', async () => {
  const { sent, registry, connect, audience } = harness(['alice']);
  connect('alice');
  await publishActivity(registry, audience, run());
  await publishActivity(registry, audience, run({ label: 'a' }));
  await publishActivity(registry, audience, run({ key: 'run-2' }));
  assert.deepEqual(sent.map(s => [s.body['run_id'], s.body['seq']]),
    [['run-1', 0], ['run-1', 1], ['run-2', 0]]);
});

test('ended is final for a run: a later push for it is not sent', async () => {
  const { sent, registry, connect, audience } = harness(['alice']);
  connect('alice');
  await publishActivity(registry, audience, run());
  await publishActivity(registry, audience, run({ state: 'ended' }));
  await publishActivity(registry, audience, run({ label: 'late' }));
  assert.deepEqual(sent.map(s => s.body['state']), ['running', 'ended']);
});

test('ended carries the thread it was given — the reply\'s, not the chat', async () => {
  const { sent, registry, connect, audience } = harness(['alice']);
  connect('alice');
  await publishActivity(registry, audience, run({ state: 'ended', threadId: 'msg-root' }));
  assert.equal(sent[0]?.body['thread_id'], 'msg-root');
});

test('refresh re-sends only what is active and stale, with the same seq', async () => {
  const clock = mock.timers;
  clock.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  try {
    const { sent, registry, connect, audience } = harness(['alice']);
    connect('alice');
    await publishActivity(registry, audience, run());
    await publishActivity(registry, audience, run({ key: 'run-2' }));
    await publishActivity(registry, audience, run({ key: 'run-2', state: 'ended' }));
    sent.length = 0;

    clock.tick(30_000);
    await refreshActivity(registry, audience);
    assert.equal(sent.length, 0, 'nothing is stale yet');

    clock.tick(30_000);
    await refreshActivity(registry, audience);
    assert.deepEqual(sent.map(s => [s.body['run_id'], s.body['seq'], s.body['state']]),
      [['run-1', 0, 'running']]);

    sent.length = 0;
    await refreshActivity(registry, audience);
    assert.equal(sent.length, 0, 'a refresh counts as a send');
  } finally {
    clock.reset();
  }
});

test('a final end is forgotten after the refresh interval, and not before', async () => {
  const clock = mock.timers;
  clock.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  try {
    const { sent, registry, connect, audience } = harness(['alice']);
    connect('alice');
    await publishActivity(registry, audience, run({ state: 'ended' }));
    clock.tick(59_999);
    await publishActivity(registry, audience, run());
    assert.equal(sent.length, 1, 'still refused inside the window');
    clock.tick(1);
    await publishActivity(registry, audience, run());
    assert.deepEqual(sent.map(s => s.body['seq']), [0, 0], 'a fresh key once forgotten');
  } finally {
    clock.reset();
  }
});

const typing = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  kind: 'typing', key: 'alice:c1:chat-1:', chatId: 'chat-1', threadId: null,
  actorId: 'alice', workspaceId: 'wsp', state: 'active', ...over,
});

test('typing is sent as activity with a ttl, and never to the typist', async () => {
  const { sent, registry, connect, audience } = harness(['alice', 'bob']);
  connect('alice'); connect('bob');
  await publishActivity(registry, audience, typing());
  assert.deepEqual(sent, [{
    actorId: 'bob', workspaceId: 'wsp', t: 'activity',
    body: {
      chat_id: 'chat-1', thread_id: null, actor_id: 'alice', kind: 'typing',
      key: 'alice:c1:chat-1:', seq: 0, state: 'active', ttl_ms: 6_000,
    },
  }]);
});

test('ended is not final for typing: the same key can type again', async () => {
  const { sent, registry, connect, audience } = harness(['bob']);
  connect('bob');
  await publishActivity(registry, audience, typing());
  await publishActivity(registry, audience, typing({ state: 'ended' }));
  await publishActivity(registry, audience, typing());
  assert.deepEqual(sent.map(s => [s.body['state'], s.body['seq']]),
    [['active', 0], ['ended', 1], ['active', 0]]);
  assert.equal(sent[1]?.body['ttl_ms'], undefined, 'an end carries no ttl');
});

test('ending typing that is not happening sends nothing', async () => {
  const { sent, registry, connect, audience } = harness(['bob']);
  connect('bob');
  assert.equal(await publishActivity(registry, audience, typing({ state: 'ended' })), false);
  assert.equal(sent.length, 0);
});

test('an unchanged active within a second is dropped, and after it is sent', async () => {
  const clock = mock.timers;
  clock.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  try {
    const { sent, registry, connect, audience } = harness(['bob']);
    connect('bob');
    await publishActivity(registry, audience, typing());
    clock.tick(999);
    assert.equal(await publishActivity(registry, audience, typing()), false);
    clock.tick(1);
    assert.equal(await publishActivity(registry, audience, typing()), true);
    assert.deepEqual(sent.map(s => s.body['seq']), [0, 1]);
  } finally {
    clock.reset();
  }
});

test('the server forgets a typing entry when its ttl runs out, pushing nothing', async () => {
  const clock = mock.timers;
  clock.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  try {
    const { sent, registry, connect, audience } = harness(['bob']);
    connect('bob');
    await publishActivity(registry, audience, typing());
    clock.tick(6_000);
    assert.equal(sent.length, 1, 'receivers expire it themselves');
    assert.equal(await publishActivity(registry, audience, typing({ state: 'ended' })), false,
      'nothing is held to end');
  } finally {
    clock.reset();
  }
});

test('typing is not sent in a chat over the audience cap', async () => {
  const many = ['alice', ...Array.from({ length: TYPING_AUDIENCE_CAP }, (_, i) => `p${i}`)];
  const { sent, registry, connect, audience } = harness(many);
  connect('p0');
  await publishActivity(registry, audience, typing());
  assert.equal(sent.length, 0);
});

test('the run kind has no audience cap', async () => {
  const many = Array.from({ length: TYPING_AUDIENCE_CAP + 1 }, (_, i) => `p${i}`);
  const { sent, registry, connect, audience } = harness(many);
  connect('p0');
  await publishActivity(registry, audience, run());
  assert.equal(sent.length, 1);
});

test('endActivityWhere ends only the matching active typing entries', async () => {
  const { sent, registry, connect, audience } = harness(['alice', 'bob', 'carol']);
  connect('bob'); connect('carol');
  await publishActivity(registry, audience, typing({ key: 'alice:c1:chat-1:' }));
  await publishActivity(registry, audience, typing({ key: 'alice:c1:chat-2:', chatId: 'chat-2' }));
  await publishActivity(registry, audience, typing({ key: 'alice:c2:chat-1:' }));
  await publishActivity(registry, audience, run({ key: 'alice:c1:run' }));
  sent.length = 0;
  await endActivityWhere(registry, audience, 'typing', 'alice:c1:');
  const ended = sent.filter(s => s.actorId === 'bob').map(s => [s.body['key'], s.body['state']]);
  assert.deepEqual(ended, [['alice:c1:chat-1:', 'ended'], ['alice:c1:chat-2:', 'ended']]);
});

test('cachedAudience asks once inside its window and again after', async () => {
  const clock = mock.timers;
  clock.enable({ apis: ['Date'], now: 0 });
  try {
    let asked = 0;
    const cached = cachedAudience(async () => { asked++; return ['bob']; }, 5_000);
    await cached('chat-1'); await cached('chat-1');
    clock.tick(5_000);
    await cached('chat-1');
    assert.equal(asked, 2);
  } finally {
    clock.reset();
  }
});
