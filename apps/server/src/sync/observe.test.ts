// The dispatcher between the engine and the catalogue — step 13 of the plan.
//
// The failure this file exists for is the one instrumentation always has: a
// marker that silently goes nowhere. `metrics.test.ts` already fails a declared
// metric with no call site; this is the other direction — a call site whose
// name no longer matches a case, which no type can catch because the seam
// carries a string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setSink, type Sink, type MetricLabels } from '@relayed/telemetry';
import { observe, recordFanout, recordOp, recordWelcome, recordSweep } from './observe.ts';

// ─── every name the engine can emit is handled ──────────────────────────────

const here = import.meta.dirname;

/** Every `note('x')` and `observe('x')` literal in the engine's own sources. */
function emitted(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(here)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    if (file === 'observe.ts') continue;
    const source = readFileSync(join(here, file), 'utf8');
    for (const [, name] of source.matchAll(/\bnote\('([a-z0-9._]+)'/g)) names.add(name!);
    for (const [, name] of source.matchAll(/\bobserve\('([a-z0-9._]+)'/g)) names.add(name!);
  }
  return [...names].sort();
}

/** Every `case 'x':` in the dispatcher. */
function handled(): Set<string> {
  const source = readFileSync(join(here, 'observe.ts'), 'utf8');
  return new Set([...source.matchAll(/case '([a-z0-9._]+)':/g)].map(m => m[1]!));
}

test('every marker the engine emits has a case in the dispatcher', () => {
  const cases = handled();
  const orphans = emitted().filter(name => !cases.has(name));
  assert.deepEqual(orphans, [],
    'these are recorded nowhere — a marker that looks wired and is not');
});

test('the dispatcher has no case nothing emits', () => {
  // The other direction, and it matters for a different reason: a stale case is
  // a metric whose panel can never move, and an empty panel reads as healthy
  // rather than as dead. Same mistake as a declared metric with no call site.
  const names = new Set(emitted());
  const stale = [...handled()].filter(name => !names.has(name)).sort();
  assert.deepEqual(stale, [], 'dead cases — the engine stopped emitting these');
});

test('the engine emits at least the connection and catch-up markers', () => {
  // A guard on the greps themselves. If the regex above stopped matching, both
  // tests would pass on an empty set and prove nothing.
  const names = new Set(emitted());
  for (const expected of ['sync.socket.connected', 'sync.socket.gone',
                          'sync.gap.sent', 'sync.catchup.sent',
                          'sync.frame.unknown']) {
    assert.ok(names.has(expected), `${expected} is no longer emitted`);
  }
});

// ─── what it actually records ───────────────────────────────────────────────

interface Recorded {
  events: { name: string; fields: Record<string, unknown> }[];
  metrics: { kind: string; metric: string; value: number;
             labels: MetricLabels | undefined }[];
}
let captured: Recorded;

function capture(): Recorded {
  captured = { events: [], metrics: [] };
  const sink: Sink = {
    event: (name, fields) =>
      captured.events.push({ name, fields: fields as Record<string, unknown> }),
    count: (metric, labels, by = 1) =>
      captured.metrics.push({ kind: 'count', metric, value: by, labels }),
    gauge: (metric, value, labels) =>
      captured.metrics.push({ kind: 'gauge', metric, value, labels }),
    histogram: (metric, value, labels) =>
      captured.metrics.push({ kind: 'histogram', metric, value, labels }),
  };
  setSink(sink);
  return captured;
}

const metric = (name: string) => captured.metrics.filter(m => m.metric === name);

test('nine close causes collapse into ONE metric with a closed label', () => {
  // The cardinality decision, asserted rather than described. Nine counters
  // would be nine names to remember and nine panels; one counter with a label
  // is one query that says which of nine things happened.
  capture();
  observe('sync.socket.hello_timeout');
  observe('sync.socket.read_timeout');
  observe('sync.socket.too_old');
  observe('sync.socket.unauthenticated');
  observe('sync.socket.gone', { close: 'server_closing', sessions: 3 });

  const closes = metric('ws.closed');
  assert.equal(closes.length, 5);
  assert.deepEqual(closes.map(c => c.labels?.['close']),
    ['hello_timeout', 'read_timeout', 'too_old', 'unauthenticated', 'server_closing']);
});

test('an unrecognised close cause becomes `error`, never itself', () => {
  // Where an open string meets a closed label set. Passing it through would let
  // one careless call site turn a ten-series metric into an unbounded one —
  // which is the failure the whole cardinality budget is about (§5).
  capture();
  observe('sync.socket.gone', { close: 'cht_01ABCDEF', sessions: 0 });
  assert.equal(metric('ws.closed')[0]?.labels?.['close'], 'error');
});

test('an ordinary disconnect is `client_stop`, not `error`', () => {
  // The default matters, because most disconnects take it. A load run reported
  // four hundred `error` closes and not one `client_stop` — every laptop lid
  // closing read as a fault on the panel whose job is telling a deploy apart
  // from an incident.
  capture();
  observe('sync.socket.gone', { close: 'client_stop', sessions: 4 });
  assert.equal(metric('ws.closed')[0]?.labels?.['close'], 'client_stop');
});

test('the session gauge is the count that REMAINS, not the one that left', () => {
  capture();
  observe('sync.socket.connected', { sessions: 12 });
  observe('sync.socket.gone', { close: 'client_stop', sessions: 11 });
  assert.deepEqual(metric('ws.sessions').map(g => g.value), [12, 11]);
});

test('a replay and a gap are the same counter, told apart by one label', () => {
  capture();
  observe('sync.catchup.sent', { events: 42 });
  observe('sync.gap.sent', { kind: 'chat' });

  assert.deepEqual(metric('sync.catchup').map(c => c.labels?.['answer']),
    ['replay', 'gap']);
  // A gap contributes NO events to the size histogram: there was no replay to
  // measure, and a zero there would drag the percentile that decides whether
  // the threshold is right.
  assert.deepEqual(metric('sync.catchup.events').map(h => h.value), [42]);
});

test('an empty replay is recorded, because level clients are most of them', () => {
  capture();
  observe('sync.catchup.sent', { events: 0 });
  assert.deepEqual(metric('sync.catchup.events').map(h => h.value), [0]);
});

test('a fanout that dropped nobody emits no drop counter at all', () => {
  // Absence is health for this one, so the alert is `> 0` (§9). A counter that
  // reported zero every time would need a threshold instead, and somebody would
  // have to pick it.
  capture();
  recordFanout('chat', 8, 0, 1.5);
  assert.equal(metric('sync.fanout.dropped').length, 0);
  assert.equal(metric('sync.fanout.audience')[0]?.value, 8);
  assert.equal(metric('sync.fanout.audience')[0]?.labels?.['stream'], 'chat');

  recordFanout('workspace', 400, 2, 9);
  assert.equal(metric('sync.fanout.dropped')[0]?.value, 2);
});

test('a refused write is counted as an op, not lost with the exception', () => {
  // A refusal is one nack on one socket. Without this it is invisible in
  // aggregate, and the person it happened to may never mention it.
  capture();
  recordOp('send', false, 4);
  assert.deepEqual(metric('sync.op')[0]?.labels, { op: 'send', result: 'error' });
  assert.equal(metric('sync.op.duration')[0]?.value, 4);
});

test('welcome records bytes and chats together — neither answers alone', () => {
  capture();
  recordWelcome(512_000, 150);
  assert.equal(metric('sync.welcome.bytes')[0]?.value, 512_000);
  assert.equal(metric('sync.chats_per_actor')[0]?.value, 150);
});

test('a sweep that deleted nothing is not a data point', () => {
  capture();
  recordSweep(0);
  assert.equal(metric('sync.retention.swept').length, 0);
  recordSweep(5_000);
  assert.equal(metric('sync.retention.swept')[0]?.value, 5_000);
});

test('an unknown marker is ignored rather than thrown', () => {
  // This runs inside frame handling. An instrumentation bug that could close a
  // socket would be a worse outage than whatever it was measuring.
  capture();
  assert.doesNotThrow(() => { observe('sync.nothing.like.this', { a: 1 }); });
  assert.equal(captured.metrics.length, 0);
});
