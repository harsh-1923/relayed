import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installNetworkGate, guardConnect } from './network.ts';

/** A stand-in target, so no test ever patches the real global. */
const target = (impl: typeof fetch) => ({ fetch: impl });
const ok = (async () => new Response('ok')) as unknown as typeof fetch;

test('offline rejects the way a real connection failure does', async () => {
  let reached = 0;
  const t = target((async () => { reached += 1; return new Response('ok'); }) as unknown as typeof fetch);
  const gate = installNetworkGate(t, { allowOffline: true });
  try {
    await t.fetch('https://example.test/a');
    assert.equal(reached, 1, 'online calls pass through');

    gate.setOffline(true);
    // A TypeError, not a custom error: that is what undici produces on a DNS or
    // connect failure, and it is what the session's `stale` path distinguishes
    // from a 401. A bespoke error would take a different branch and the
    // simulation would stop simulating.
    await assert.rejects(t.fetch('https://example.test/b'), TypeError);
    assert.equal(reached, 1, 'nothing reached the network');

    gate.setOffline(false);
    await t.fetch('https://example.test/c');
    assert.equal(reached, 2, 'and it comes back');
  } finally { gate.uninstall(); }
});

test('offline rejects rather than throws, so a caller that never awaits is safe', () => {
  const t = target(ok);
  const gate = installNetworkGate(t, { allowOffline: true });
  try {
    gate.setOffline(true);
    // Called without await: this must return a promise, not explode at the call
    // site. `void fetch(...)` appears throughout the sync engine.
    const p = t.fetch('https://example.test/x');
    assert.ok(p instanceof Promise);
    p.catch(() => {});
  } finally { gate.uninstall(); }
});

test('calls before first paint are counted; after are not', async () => {
  const t = target(ok);
  const gate = installNetworkGate(t, { trace: true });
  try {
    await t.fetch('https://example.test/early-1');
    await t.fetch('https://example.test/early-2');
    assert.equal(gate.callsBeforePaint.length, 2);

    gate.markPaintable();
    await t.fetch('https://example.test/ordinary-sync-traffic');
    assert.equal(gate.callsBeforePaint.length, 2,
      'ordinary traffic after paint is not an R3 violation');
  } finally { gate.uninstall(); }
});

test('the trace is opt-in; the counter is not', async () => {
  const t = target(ok);
  const gate = installNetworkGate(t);       // no trace
  try {
    await t.fetch('https://example.test/early');
    // The URL list is a debugging aid. The COUNTER is always on, because an
    // invariant checked only when somebody remembers to check it is not
    // instrumented — that is why this defaults off and the metric does not.
    assert.deepEqual(gate.callsBeforePaint, []);
  } finally { gate.uninstall(); }
});

test('uninstall restores the original, leaving no patched global behind', async () => {
  let reached = 0;
  const t = target((async () => { reached += 1; return new Response('ok'); }) as unknown as typeof fetch);
  const original = t.fetch;
  const gate = installNetworkGate(t, { allowOffline: true });
  gate.setOffline(true);
  gate.uninstall();
  assert.equal(t.fetch, original);
  await t.fetch('https://example.test/after-uninstall');
  assert.equal(reached, 1, 'offline does not survive uninstall');
});

test('a production build cannot be switched offline at all', async () => {
  // Not "the button is hidden" — the branch does not exist. A dev affordance
  // that can disable the network must be absent from a packaged build rather
  // than unreachable in one, because unreachable is a property of today's call
  // sites and absent is a property of the binary.
  let reached = 0;
  const t = target((async () => { reached += 1; return new Response('ok'); }) as unknown as typeof fetch);
  const gate = installNetworkGate(t);          // no allowOffline
  try {
    assert.equal(gate.canGoOffline, false);
    gate.setOffline(true);                     // ignored, not obeyed
    assert.equal(gate.offline, false);
    await t.fetch('https://example.test/still-works');
    assert.equal(reached, 1, 'production traffic must be unaffected');
  } finally { gate.uninstall(); }
});

test('counting still ships when offline simulation does not', async () => {
  // The two halves have different lifetimes: R3's counter is an invariant
  // metric and always on, the switch is development only.
  const t = target(ok);
  const gate = installNetworkGate(t, { trace: true });
  try {
    await t.fetch('https://example.test/early');
    assert.equal(gate.callsBeforePaint.length, 1);
    assert.equal(gate.canGoOffline, false);
  } finally { gate.uninstall(); }
});

test('guardConnect covers what patching fetch cannot', () => {
  // Patching globalThis.fetch catches fetch and NOTHING else — a WebSocket is a
  // separate constructor. Without this, Phase 2's socket would be invisible to
  // both jobs: a connection opened before first paint would go uncounted, and
  // simulated offline would be half a simulation.
  const t = target(ok);
  const gate = installNetworkGate(t, { allowOffline: true });
  try {
    assert.doesNotThrow(() => guardConnect(gate, 'wss://relayed.test/sync'));
    gate.setOffline(true);
    assert.throws(() => guardConnect(gate, 'wss://relayed.test/sync'), TypeError);
    gate.setOffline(false);
    assert.doesNotThrow(() => guardConnect(gate, 'wss://relayed.test/sync'));
  } finally { gate.uninstall(); }
});
