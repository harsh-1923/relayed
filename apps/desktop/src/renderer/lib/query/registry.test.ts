import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, type RegistryReport, type RunQuery } from './registry.ts';

/** A run function that records every read and lets each one be settled by hand. */
function recorder(answer: (name: string, args: unknown) => unknown = () => []) {
  const calls: { name: string; args: unknown }[] = [];
  const held: ((rows: unknown) => void)[] = [];
  let hold = false;

  const run: RunQuery = (name, args) => {
    calls.push({ name, args });
    if (!hold) return Promise.resolve(answer(name, args));
    return new Promise(resolve => { held.push(resolve); });
  };
  return {
    run, calls, held,
    countFor: (name: string) => calls.filter(c => c.name === name).length,
    holdReplies: () => { hold = true; },
  };
}

const settled = () => new Promise(resolve => { setTimeout(resolve, 0); });

test('an invalidation refetches only the mounted queries that read it', async () => {
  const io = recorder();
  const registry = createRegistry(io.run);

  registry.subscribe('actors.list', undefined, ['actors'], () => {});
  registry.subscribe('messages.page', { chatId: 'c_eng' }, ['chat:c_eng:messages'], () => {});
  registry.subscribe('chat.header', { chatId: 'c_eng' }, ['chat:c_eng:meta'], () => {});
  await settled();
  assert.equal(io.calls.length, 3, 'each mount reads once');

  registry.invalidate(['chat:c_eng:messages']);
  await settled();

  assert.equal(io.calls.length, 4, 'exactly one refetch');
  assert.equal(io.countFor('messages.page'), 2);
  // The negative half, and the point of the test: a sibling facet and an
  // unrelated topic must NOT be woken.
  assert.equal(io.countFor('chat.header'), 1);
  assert.equal(io.countFor('actors.list'), 1);
});

test('NEGATIVE CONTROL: a topic all three read wakes all three', async () => {
  // Without this, the test above also passes when nothing refetches at all —
  // the failure mode it is meant to catch. The authz spike and the metric
  // call-site test both passed for exactly this reason once (FRONTEND.md §11).
  const io = recorder();
  const registry = createRegistry(io.run);

  registry.subscribe('a', undefined, ['chat:c_eng:messages'], () => {});
  registry.subscribe('b', undefined, ['chat:c_eng:meta'], () => {});
  registry.subscribe('c', undefined, ['chat'], () => {});
  await settled();

  registry.invalidate(['chat:c_eng:messages', 'chat:c_eng:meta']);
  await settled();

  assert.equal(io.calls.length, 6, 'three mounts, three refetches');
});

test('an unmounted query is never refetched again', async () => {
  const io = recorder();
  const registry = createRegistry(io.run);

  const unsubscribe = registry.subscribe('actors.list', undefined, ['actors'], () => {});
  await settled();
  assert.equal(registry.size, 1);

  unsubscribe();
  assert.equal(registry.size, 0, 'the entry is dropped, not retained');

  registry.invalidate(['actors']);
  await settled();
  assert.equal(io.countFor('actors.list'), 1, 'the mount read, and nothing since');
});

test('two components sharing a read share one entry and one refetch', async () => {
  const io = recorder();
  const registry = createRegistry(io.run);
  let notified = 0;

  const first = registry.subscribe('actors.list', undefined, ['actors'], () => { notified += 1; });
  const second = registry.subscribe('actors.list', undefined, ['actors'], () => { notified += 1; });
  await settled();
  assert.equal(registry.size, 1);
  assert.equal(io.calls.length, 1, 'the second mount joins the existing entry');

  registry.invalidate(['actors']);
  await settled();
  assert.equal(io.calls.length, 2, 'one refetch, not two');
  assert.equal(notified, 4, 'both listeners run for both reads');

  // The entry survives until the LAST reader leaves.
  first();
  assert.equal(registry.size, 1);
  second();
  assert.equal(registry.size, 0);
});

test('argument order does not create a second entry', async () => {
  const io = recorder();
  const registry = createRegistry(io.run);

  registry.subscribe('messages.page', { chatId: 'c_eng', before: 50 }, ['chat:c_eng'], () => {});
  registry.subscribe('messages.page', { before: 50, chatId: 'c_eng' }, ['chat:c_eng'], () => {});
  await settled();

  assert.equal(registry.size, 1, 'the same read, however the object was built');
  assert.equal(io.calls.length, 1);
});

test('a reply that lands after unmount is dropped', async () => {
  const io = recorder();
  io.holdReplies();
  const registry = createRegistry(io.run);
  let notified = 0;

  const unsubscribe = registry.subscribe('actors.list', undefined, ['actors'], () => { notified += 1; });
  unsubscribe();
  io.held[0]?.([{ id: 'a_alice' }]);
  await settled();

  assert.equal(notified, 0, 'nothing to notify — the entry is gone');
  assert.equal(registry.size, 0);
});

test('a superseded reply loses to the newer one, whatever the arrival order', async () => {
  const io = recorder();
  io.holdReplies();
  const registry = createRegistry(io.run);
  registry.subscribe('actors.list', undefined, ['actors'], () => {});

  registry.invalidate(['actors']);
  await settled();
  assert.equal(io.held.length, 2, 'the mount read and the refetch are both in flight');

  // The newer read answers first, then the older one arrives late.
  io.held[1]?.(['new']);
  io.held[0]?.(['old']);
  await settled();

  assert.deepEqual(registry.snapshot('actors.list', undefined).rows, ['new']);
});

test('a failed read keeps the rows it had rather than reporting empty', async () => {
  let attempt = 0;
  const run: RunQuery = () => {
    attempt += 1;
    return attempt === 1 ? Promise.resolve(['alice']) : Promise.reject(new Error('disk gone'));
  };
  const registry = createRegistry(run);
  registry.subscribe('actors.list', undefined, ['actors'], () => {});
  await settled();
  assert.deepEqual(registry.snapshot('actors.list', undefined).rows, ['alice']);

  registry.invalidate(['actors']);
  await settled();

  const snapshot = registry.snapshot('actors.list', undefined);
  // Rendering "nothing here" over a populated replica is the one failure a
  // local-first app must never produce (FRONTEND.md §6.2).
  assert.deepEqual(snapshot.rows, ['alice']);
  assert.equal(snapshot.loaded, true);
  assert.equal(snapshot.error, 'disk gone');
});

test('a superseded reply (a workspace switch) does not clear the rows', async () => {
  // `call` normalises a reply belonging to the workspace we just left to null.
  // That is a non-result, not an empty directory.
  let attempt = 0;
  const run: RunQuery = () => Promise.resolve(++attempt === 1 ? ['alice'] : null);
  const registry = createRegistry(run);
  registry.subscribe('actors.list', undefined, ['actors'], () => {});
  await settled();

  registry.invalidate(['actors']);
  await settled();
  assert.deepEqual(registry.snapshot('actors.list', undefined).rows, ['alice']);
});

test('invalidateAll refetches every entry regardless of topic', async () => {
  const io = recorder();
  const registry = createRegistry(io.run);
  registry.subscribe('a', undefined, ['actors'], () => {});
  registry.subscribe('b', undefined, ['chat:c_eng'], () => {});
  await settled();

  registry.invalidateAll();
  await settled();
  assert.equal(io.calls.length, 4);
});

test('an empty invalidation wakes nothing', async () => {
  const io = recorder();
  const registry = createRegistry(io.run);
  registry.subscribe('a', undefined, ['actors'], () => {});
  await settled();

  registry.invalidate([]);
  await settled();
  assert.equal(io.calls.length, 1);
});

test('the snapshot identity is stable until the rows change', async () => {
  // useSyncExternalStore compares by identity and loops for ever if getSnapshot
  // returns a fresh object each call.
  const io = recorder();
  const registry = createRegistry(io.run);
  registry.subscribe('actors.list', undefined, ['actors'], () => {});

  const before = registry.snapshot('actors.list', undefined);
  assert.equal(registry.snapshot('actors.list', undefined), before);
  await settled();
  const after = registry.snapshot('actors.list', undefined);
  assert.notEqual(after, before, 'a completed read is a new snapshot');
  assert.equal(registry.snapshot('actors.list', undefined), after);
});

/** Collects what the registry reports, in order. */
function watcher() {
  const reads: { name: string; trigger: string; invalidation: number; rows: number; ok: boolean }[] = [];
  const deliveries: { invalidation: number; mounted: number; matched: number }[] = [];
  const report: RegistryReport = {
    read: i => { reads.push({ name: i.name, trigger: i.trigger, invalidation: i.invalidation, rows: i.rows, ok: i.ok }); },
    delivered: i => { deliveries.push(i); },
  };
  return { report, reads, deliveries };
}

test('a read reports what caused it, and mounts carry no invalidation id', async () => {
  const io = recorder(() => [{ id: 'a_alice' }, { id: 'a_bob' }]);
  const seen = watcher();
  const registry = createRegistry(io.run, seen.report);

  registry.subscribe('actors.list', undefined, ['actors'], () => {});
  await settled();
  assert.deepEqual(seen.reads, [
    { name: 'actors.list', trigger: 'mount', invalidation: 0, rows: 2, ok: true },
  ]);

  registry.invalidate(['actors'], 41);
  await settled();
  assert.deepEqual(seen.reads[1],
    { name: 'actors.list', trigger: 'invalidate', invalidation: 41, rows: 2, ok: true });

  registry.invalidateAll();
  await settled();
  assert.equal(seen.reads[2]?.trigger, 'epoch');
});

test('a push that woke NOTHING is still reported', async () => {
  // The silent case, and the reason `delivered` fires unconditionally: a topic
  // the write side and the read side disagree about wakes nobody, raises no
  // error, and leaves the surface stale. `matched: 0` is the only trace of it.
  const io = recorder();
  const seen = watcher();
  const registry = createRegistry(io.run, seen.report);
  registry.subscribe('actors.list', undefined, ['actors'], () => {});
  await settled();

  registry.invalidate(['chat:c_eng:messages'], 42);
  await settled();

  assert.equal(io.countFor('actors.list'), 1, 'nothing refetched');
  assert.deepEqual(seen.deliveries, [{ invalidation: 42, mounted: 1, matched: 0 }]);
});

test('a failed read is reported as a read, not as silence', async () => {
  const seen = watcher();
  const registry = createRegistry(() => Promise.reject(new Error('disk gone')), seen.report);
  registry.subscribe('actors.list', undefined, ['actors'], () => {});
  await settled();
  assert.equal(seen.reads[0]?.ok, false);
});
