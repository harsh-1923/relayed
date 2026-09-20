import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryUploader } from './telemetry-upload.ts';

const rec = (n: string) => ({ kind: 'count' as const, name: n });

test('a full buffer drops the OLDEST, and counts what it dropped', async () => {
  // Newest-wins, deliberately: a buffer fills when something is going wrong,
  // and the records describing the present are the ones worth keeping.
  const u = new TelemetryUploader({ token: () => 't' });
  for (let i = 0; i < 2_100; i++) u.add(rec(`m${i}`));
  assert.equal(u.depth, 2_000, 'bounded');
  assert.equal(u.droppedCount, 100, 'the loss is counted, not silent');
});

test('signed out: nothing is posted and nothing is lost', async () => {
  let called = false;
  const u = new TelemetryUploader({
    token: () => null,
    fetchImpl: (async () => { called = true; return new Response('', { status: 202 }); }) as never,
  });
  u.add(rec('a'));
  assert.equal(await u.flush(), 0);
  assert.equal(called, false, 'no unauthenticated post');
  assert.equal(u.depth, 1, 'the record waits for a session');
});

test('a failed post DISCARDS the batch and counts it, rather than retrying', async () => {
  // A retry queue for telemetry grows while the network is down and then
  // competes with the outbox — which carries things a person typed.
  const u = new TelemetryUploader({
    token: () => 't',
    fetchImpl: (async () => { throw new Error('offline'); }) as never,
  });
  u.add(rec('a')); u.add(rec('b'));
  assert.equal(await u.flush(), 0);
  assert.equal(u.depth, 0, 'not requeued');
  assert.equal(u.droppedCount, 2, 'counted instead');
});

test('a non-2xx is a loss too, not a silent success', async () => {
  const u = new TelemetryUploader({
    token: () => 't',
    fetchImpl: (async () => new Response('nope', { status: 500 })) as never,
  });
  u.add(rec('a'));
  assert.equal(await u.flush(), 0);
  assert.equal(u.droppedCount, 1);
});

test('a successful post clears the batch and reports how many went', async () => {
  let body: string | undefined;
  const u = new TelemetryUploader({
    token: () => 't',
    fetchImpl: (async (_u: string, init: RequestInit) => {
      body = init.body as string;
      return new Response('', { status: 202 });
    }) as never,
  });
  u.add(rec('a')); u.add(rec('b'));
  assert.equal(await u.flush(), 2);
  assert.equal(u.depth, 0);
  assert.equal(JSON.parse(body ?? '{}').records.length, 2);
});

test('the drop count travels with the next batch, then resets', async () => {
  // Otherwise a dashboard cannot say whether the numbers beside it are complete.
  let seen: number | undefined;
  const u = new TelemetryUploader({
    token: () => 't',
    fetchImpl: (async (_u: string, init: RequestInit) => {
      seen = JSON.parse(init.body as string).dropped;
      return new Response('', { status: 202 });
    }) as never,
  });
  for (let i = 0; i < 2_050; i++) u.add(rec(`m${i}`));
  await u.flush();
  assert.equal(seen, 50, 'reported');
  await u.flush();
  assert.equal(seen, 0, 'and not double-counted');
});
