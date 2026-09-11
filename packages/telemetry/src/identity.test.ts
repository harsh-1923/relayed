// Who a record came from, and the split that decides where each half may go.
//
// THE RULE THIS FILE EXISTS TO HOLD. Both halves belong on logs and traces;
// only the bounded one may go near a metric. That is not a preference — a
// resource attribute becomes part of a metric's identifying label set in any
// Prometheus-shaped backend, so a device id there is 100 actors × 150 chats =
// 15,000 series for a single metric (OBSERVABILITY.md §5).
//
// The failure is silent and arrives as a bill, so it is asserted rather than
// remembered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OtlpSink } from './otlp.ts';
import type { Sink } from './index.ts';

/** Read an OTLP attribute list back into an object. */
const read = (attributes: { key: string; value: Record<string, unknown> }[]):
  Record<string, unknown> =>
  Object.fromEntries(attributes.map(a => [a.key, Object.values(a.value)[0]]));

/** A sink whose posts we capture instead of sending. */
function sink(): { otlp: OtlpSink; posted: Record<string, unknown>[] } {
  const posted: Record<string, unknown>[] = [];
  const otlp = new OtlpSink({ service: 'desktop', flushMs: 1_000_000 });
  // The transport is the one thing a unit test must not exercise.
  (globalThis as { fetch: unknown }).fetch = async (_url: string, init: { body: string }) => {
    posted.push(JSON.parse(init.body) as Record<string, unknown>);
    return { ok: true } as Response;
  };
  return { otlp, posted };
}

const logsOf = (posted: Record<string, unknown>[]): Record<string, unknown>[] => {
  const body = posted.find(p => 'resourceLogs' in p) as
    { resourceLogs: { scopeLogs: { logRecords: Record<string, unknown>[] }[] }[] } | undefined;
  return body?.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? [];
};
const resourceOf = (posted: Record<string, unknown>[]): Record<string, unknown> => {
  const body = posted.find(p => 'resourceLogs' in p) as
    { resourceLogs: { resource: { attributes: never[] } }[] } | undefined;
  return body ? read(body.resourceLogs[0]!.resource.attributes) : {};
};

test('the BOUNDED half rides the resource, where every signal carries it', async () => {
  const { otlp, posted } = sink();
  otlp.identify({ os: 'darwin', arch: 'arm64', env: 'development' });
  otlp.event('ws.connected', { attempt: 0 });
  await otlp.flush();

  assert.deepEqual(resourceOf(posted), {
    'service.name': 'relayed-desktop',
    'os.type': 'darwin',
    'host.arch': 'arm64',
    'deployment.environment': 'development',
  });
});

test('the UNBOUNDED half rides each event, never the resource', async () => {
  // On the resource it would become a Loki stream label and a metric label at
  // once. Per record it is structured metadata — queryable, and free.
  const { otlp, posted } = sink();
  otlp.identify({ device: 'dev_a', actor: 'act_a', workspace: 'wsp_a', install: 'ins_a' });
  otlp.event('ws.connected', { attempt: 3 });
  await otlp.flush();

  const record = read((logsOf(posted)[0] as { attributes: never[] }).attributes);
  assert.equal(record['device'], 'dev_a');
  assert.equal(record['actor'], 'act_a');
  assert.equal(record['workspace'], 'wsp_a');
  // A STRING, and correctly so: protobuf's JSON mapping encodes int64 as a
  // string, which is what `intValue` carries. Asserting the number would be
  // asserting a bug.
  assert.equal(record['attempt'], '3', 'and the event keeps its own fields');

  const resource = resourceOf(posted);
  for (const key of ['device', 'actor', 'workspace', 'install']) {
    assert.equal(key in resource, false, `${key} must not be on the resource`);
  }
});

test('A METRIC CARRIES NEITHER AN ID NOR A VERSION', async () => {
  // The one that costs money. Every unbounded field on a metric multiplies its
  // series count by that field's cardinality, and nothing fails — the bill
  // arrives weeks later.
  const { otlp, posted } = sink();
  otlp.identify({
    os: 'darwin', version: '1.4.2',
    device: 'dev_a', actor: 'act_a', workspace: 'wsp_a', install: 'ins_a',
  });
  otlp.count('sync.invalidate', undefined, 1);
  await otlp.flush();

  const metric = logsOf(posted)
    .map(r => read((r as { attributes: never[] }).attributes))
    .find(a => a['metric.name'] === 'sync.invalidate');
  assert.ok(metric, 'the metric was sent');
  for (const key of ['device', 'actor', 'workspace', 'install', 'version']) {
    assert.equal(key in metric, false, `${key} must never label a metric`);
  }
});

test('the version goes out ONCE, as its own gauge', async () => {
  // §5's `client_version` trap. Per-version attribution has to come from
  // somewhere and everywhere is the wrong answer: on the resource it multiplies
  // the whole catalogue by the number of releases in the field.
  const { otlp, posted } = sink();
  otlp.identify({ version: '1.4.2' });
  await otlp.flush();

  const info = logsOf(posted)
    .map(r => read((r as { attributes: never[] }).attributes))
    .find(a => a['metric.name'] === 'client.info');
  assert.ok(info, 'client.info was emitted');
  assert.equal(info['version'], '1.4.2');
  assert.equal('version' in resourceOf(posted), false, 'and not on the resource');
});

test('identify MERGES, so a later call does not erase what an earlier one said',
  async () => {
    // Boot knows the platform; only sign-in knows the actor. If the second call
    // replaced the first, every record after sign-in would lose its platform —
    // and the gap would look like a fleet that stopped reporting one.
    const { otlp, posted } = sink();
    otlp.identify({ os: 'darwin', install: 'ins_a' });
    otlp.identify({ device: 'dev_a' });
    otlp.event('ws.connected', { attempt: 0 });
    await otlp.flush();

    assert.equal(resourceOf(posted)['os.type'], 'darwin');
    const record = read((logsOf(posted).at(-1) as { attributes: never[] }).attributes);
    assert.equal(record['install'], 'ins_a');
    assert.equal(record['device'], 'dev_a');
  });

test('an event that names its own field OUTRANKS the ambient one', async () => {
  // `auth.signed_in` carries the actor it is about, which is not necessarily
  // the one currently signed in — a sign-out then sign-in as somebody else is
  // exactly when the two differ, and exactly when it matters.
  const { otlp, posted } = sink();
  otlp.identify({ actor: 'act_ambient' });
  otlp.event('identity.deactivated', { actor: 'act_subject', via: 'api' });
  await otlp.flush();

  const record = read((logsOf(posted).at(-1) as { attributes: never[] }).attributes);
  assert.equal(record['actor'], 'act_subject');
});

// ─── the tee must forward it ────────────────────────────────────────────────

test('a SINK COMPOSED OF OTHERS forwards identify like everything else', () => {
  // The bug this caught, and it failed silently: `useOtlpIfConfigured` builds a
  // tee so a dev terminal stays readable while the collector gets the
  // structured copy, and it forwarded four methods of five. `identify` returned
  // without error and every record went out with no device, no actor and no
  // platform — exactly as if nobody had called it.
  //
  // Asserted structurally rather than by wiring a real tee: the rule is that a
  // composed sink implements the whole interface, and a method added later must
  // not be able to slip through the same gap.
  const seen: string[] = [];
  const leg = (name: string): Sink => ({
    event: () => seen.push(`${name}:event`),
    count: () => seen.push(`${name}:count`),
    gauge: () => seen.push(`${name}:gauge`),
    histogram: () => seen.push(`${name}:histogram`),
    recordSpan: () => seen.push(`${name}:span`),
    identify: () => seen.push(`${name}:identify`),
  });
  const a = leg('a');
  const b = leg('b');
  const tee: Sink = {
    event: (n, f) => { a.event(n, f); b.event(n, f); },
    count: (m, l, by) => { a.count(m, l, by); b.count(m, l, by); },
    gauge: (m, v, l) => { a.gauge(m, v, l); b.gauge(m, v, l); },
    histogram: (m, v, l) => { a.histogram(m, v, l); b.histogram(m, v, l); },
    recordSpan: (s) => { a.recordSpan?.(s); b.recordSpan?.(s); },
    identify: (w) => { a.identify?.(w); b.identify?.(w); },
  };

  // Every optional method of `Sink` must be present on a tee, or the next one
  // added is the next one silently dropped.
  for (const method of ['event', 'count', 'gauge', 'histogram', 'recordSpan', 'identify']) {
    assert.equal(typeof (tee as unknown as Record<string, unknown>)[method], 'function',
      `a composed sink must forward ${method}`);
  }

  tee.identify?.({ device: 'dev_a' });
  assert.deepEqual(seen, ['a:identify', 'b:identify'], 'and to BOTH legs');
});
