// The dispatcher between the engine and the catalogue, client half.
// Step 13 of the sync build plan (docs/SYNC-FLOWS.md §2).
//
// Same failure guarded against as on the server: a marker that looks wired and
// goes nowhere. The seam carries a string, so no type can catch a name that
// stopped matching a case — these greps can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setSink, type Sink, type MetricLabels } from '@relayed/telemetry';
import { CLOSE } from '@relayed/protocol';
import { observe } from './observe.ts';

const here = import.meta.dirname;

/** Every `note('x')`, `#note('x')` and `observe('x')` literal in the engine. */
function emitted(): string[] {
  const names = new Set<string>();
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);

  for (const file of walk(here)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    if (file.endsWith('observe.ts')) continue;
    const source = readFileSync(file, 'utf8');
    for (const [, name] of source.matchAll(/\bnote\('([a-z0-9._]+)'/g)) names.add(name!);
    for (const [, name] of source.matchAll(/\bobserve\('([a-z0-9._]+)'/g)) names.add(name!);
  }
  return [...names].sort();
}

function handled(): Set<string> {
  const source = readFileSync(join(here, 'observe.ts'), 'utf8');
  return new Set([...source.matchAll(/case '([a-z0-9._]+)':/g)].map(m => m[1]!));
}

test('every marker the engine emits has a case in the dispatcher', () => {
  const cases = handled();
  assert.deepEqual(emitted().filter(name => !cases.has(name)), []);
});

test('the dispatcher has no case nothing emits', () => {
  const names = new Set(emitted());
  assert.deepEqual([...handled()].filter(name => !names.has(name)).sort(), []);
});

test('all nine declared sync events have a call site', () => {
  // The step-13 criterion, checked rather than believed. These were declared in
  // Phase 1 and wired in one pass; until this pass every one of them was a
  // catalogue entry that nothing could ever produce.
  const names = new Set(emitted());
  for (const declared of [
    'sync.gap.entered', 'sync.event.unknown', 'sync.cursor.stalled',
    'sync.backfill.page', 'outbox.op.failed', 'outbox.coalesced',
    'ws.connected', 'ws.disconnected', 'ws.zombie.detected',
  ]) {
    assert.ok(names.has(declared), `${declared} is declared and never emitted`);
  }
});

// ─── what it actually records ───────────────────────────────────────────────

interface Recorded {
  events: { name: string; fields: Record<string, unknown> }[];
  metrics: { kind: string; metric: string; value: number;
             labels: MetricLabels | undefined }[];
}
let captured: Recorded;

function capture(): void {
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
}

const metric = (name: string) => captured.metrics.filter(m => m.metric === name);
const event = (name: string) => captured.events.filter(e => e.name === name);

test('a gap produces BOTH an event and a counter, and they answer different things',
  () => {
    // The split §5 is built on. The event carries ids and answers "which chat,
    // how far behind, for this person"; the counter carries a closed label and
    // answers "how often, across everybody" — and only the counter survives
    // past fourteen days.
    capture();
    observe('sync.gap.entered', {
      stream: 'chat', id: 'cht_1', head_rev: 9_000, cursor_rev: 12,
    });

    assert.deepEqual(event('sync.gap.entered')[0]?.fields,
      { stream: 'chat', id: 'cht_1', head_rev: 9_000, cursor_rev: 12 });
    assert.deepEqual(metric('sync.gap')[0]?.labels, { stream: 'chat' });
  });

test('a stream kind the catalogue does not know becomes `chat`, never itself', () => {
  // A closed label meeting an open string, same as the server's close causes.
  capture();
  observe('sync.gap.entered', { stream: 'wsp_01ABCDEF', id: 'x' });
  assert.equal(metric('sync.gap')[0]?.labels?.['stream'], 'chat');
});

test('a retryable nack counts as `retrying`, a permanent one as `failed`', () => {
  // The distinction the whole write path turns on: one is a message that will
  // still go, the other is a red message somebody has to act on.
  capture();
  observe('outbox.op.failed', { retryable: true, attempts: 2, kind: 'send' });
  observe('outbox.op.failed', { retryable: false, attempts: 1, kind: 'delete' });

  assert.deepEqual(metric('outbox.op').map(m => m.labels),
    [{ op: 'send', settled: 'retrying' }, { op: 'delete', settled: 'failed' }]);
  assert.deepEqual(event('outbox.op.failed').map(e => e.fields),
    [{ attempts: 2, retryable: true }, { attempts: 1, retryable: false }]);
});

test('a coalesced op is a success, not a loss', () => {
  // Send-then-delete offline collapses to ZERO network operations (invariant
  // 6). Counting that as `acked` would make the write path look busier than it
  // is; counting it as `failed` would make a correct outcome look like a bug.
  capture();
  observe('outbox.coalesced', { dropped: 2 });
  assert.equal(metric('outbox.op')[0]?.labels?.['settled'], 'coalesced');
  assert.deepEqual(event('outbox.coalesced')[0]?.fields, { dropped: 2 });
});

test('a connect records the EVENT and no gauge', () => {
  // A client-side session gauge was written and removed. It is a one-or-zero
  // no panel reads, and the server already reports the number that matters —
  // the same argument that declined four metrics in the catalogue.
  capture();
  observe('ws.connected', { attempt: 3 });
  assert.deepEqual(event('ws.connected')[0]?.fields, { attempt: 3 });
  assert.deepEqual(captured.metrics, []);
});

test('the close code is read as a CAUSE, and 1000 is us, not a failure', () => {
  capture();
  observe('ws.disconnected', { code: 1000, uptime: 60_000 });
  observe('ws.disconnected', { code: CLOSE.goingAway, uptime: 1 });
  observe('ws.disconnected', { code: CLOSE.unauthenticated, uptime: 1 });
  observe('ws.disconnected', { code: 1006, uptime: 1 });

  assert.deepEqual(metric('ws.closed').map(m => m.labels?.['close']),
    ['client_stop', 'server_closing', 'unauthenticated', 'error']);
});

test('the frontier sample carries both halves of invariant 1', () => {
  capture();
  observe('sync.frontier', { lag: 340, staged: 7 });
  assert.equal(metric('sync.cursor.lag')[0]?.value, 340);
  assert.equal(metric('sync.staged.depth')[0]?.value, 7);
});

test('an unknown event reports WHICH type, or the count cannot be acted on', () => {
  capture();
  observe('sync.event.unknown', { stream: 'chat', type: 'message.pinned', rev: 88 });
  assert.deepEqual(event('sync.event.unknown')[0]?.fields,
    { stream: 'chat', type: 'message.pinned', rev: 88 });
});

test('a directory page that never came back is a directory failure', () => {
  // Not a dropped frame. The consequence is authors rendering as monograms,
  // which is what `directory.synced` is about — and routing it to the transport
  // counter would put it next to numbers nobody would connect it to.
  capture();
  observe('sync.directory.timeout');
  assert.deepEqual(metric('directory.synced')[0]?.labels, { result: 'error' });
});

test('an unknown marker is ignored rather than thrown', () => {
  capture();
  assert.doesNotThrow(() => { observe('nothing.like.this'); });
  assert.equal(captured.metrics.length + captured.events.length, 0);
});
