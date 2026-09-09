import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayTelemetry, type RelaySink } from './telemetry-relay.ts';

function collector() {
  const calls: string[] = [];
  const sink: RelaySink = {
    event: (name, fields) => { calls.push(`event:${name}:${JSON.stringify(fields)}`); },
    count: (name, labels) => { calls.push(`count:${name}:${JSON.stringify(labels)}`); },
    histogram: (name, value, labels) =>
      { calls.push(`histogram:${name}:${value}:${JSON.stringify(labels)}`); },
    dropped: (n) => { calls.push(`dropped:${n}`); },
  };
  return { sink, calls };
}

test('a catalogued event is relayed', () => {
  const io = collector();
  const outcome = relayTelemetry(
    { kind: 'event', name: 'ui.route.changed', fields: { from: '/', to: '/w/1', workspace: 'w1' } },
    io.sink);
  assert.equal(outcome, 'event');
  assert.deepEqual(io.calls, ['event:ui.route.changed:{"from":"/","to":"/w/1","workspace":"w1"}']);
});

test('a catalogued metric is relayed, counter and histogram alike', () => {
  const io = collector();
  assert.equal(relayTelemetry(
    { kind: 'count', name: 'ui.surface.state', labels: { surface: 'live' } }, io.sink), 'count');
  assert.equal(relayTelemetry(
    { kind: 'histogram', name: 'ui.query.duration', value: 0.4,
      labels: { trigger: 'mount', result: 'ok' } }, io.sink), 'histogram');
  assert.deepEqual(io.calls, [
    'count:ui.surface.state:{"surface":"live"}',
    'histogram:ui.query.duration:0.4:{"trigger":"mount","result":"ok"}',
  ]);
});

test('an UNCATALOGUED name is dropped — this is the runtime boundary', () => {
  // The compile-time check only binds callers who ran our compiler. This is
  // what holds against one who did not (OBSERVABILITY.md §8).
  const io = collector();
  assert.equal(relayTelemetry({ kind: 'event', name: 'made.up.event', fields: {} }, io.sink), 'dropped');
  assert.equal(relayTelemetry({ kind: 'count', name: 'made.up.metric' }, io.sink), 'dropped');
  assert.equal(relayTelemetry({ kind: 'histogram', name: 'made.up.metric', value: 1 }, io.sink), 'dropped');
  assert.deepEqual(io.calls, []);
});

test('a metric name is not accepted as an event name, or the reverse', () => {
  // The two catalogues are separate on purpose; crossing them would let an
  // id-bearing event shape reach a metric label.
  const io = collector();
  assert.equal(relayTelemetry({ kind: 'event', name: 'ui.query.duration', fields: {} }, io.sink), 'dropped');
  assert.equal(relayTelemetry({ kind: 'count', name: 'ui.route.changed' }, io.sink), 'dropped');
  assert.deepEqual(io.calls, []);
});

test('garbage never throws — telemetry must not be able to fail a UI action', () => {
  const io = collector();
  for (const junk of [null, undefined, 42, 'nope', [], {}, { kind: 'span', name: 'x' },
                      { kind: 'histogram', name: 'ui.query.woken' },
                      { kind: 'histogram', name: 'ui.query.woken', value: 'lots' },
                      { kind: 'histogram', name: 'ui.query.woken', value: NaN }]) {
    assert.equal(relayTelemetry(junk, io.sink), 'dropped');
  }
  assert.deepEqual(io.calls, []);
});

test('a structural value never reaches a label position', () => {
  // An object or an array in a label is an unbounded series, which is the one
  // failure the 10k cap cannot absorb (OBSERVABILITY.md §5).
  const io = collector();
  relayTelemetry({ kind: 'count', name: 'ui.surface.state',
                   labels: { surface: 'live', rogue: { actor: 'a_alice' }, list: ['a', 'b'] } },
                 io.sink);
  assert.deepEqual(io.calls, ['count:ui.surface.state:{"surface":"live"}']);
});

test('dropped records are counted even when the record itself is rejected', () => {
  const io = collector();
  relayTelemetry({ kind: 'event', name: 'made.up.event', dropped: 7 }, io.sink);
  assert.deepEqual(io.calls, ['dropped:7'],
    'the drop is the half worth knowing about, whatever the record was');
});

test('a zero drop count says nothing and is not reported', () => {
  const io = collector();
  relayTelemetry({ kind: 'count', name: 'ui.query.woken', dropped: 0 }, io.sink);
  assert.deepEqual(io.calls, ['count:ui.query.woken:{}']);
});
