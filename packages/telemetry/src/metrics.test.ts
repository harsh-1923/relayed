import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  metrics, labelValues, cardinality, type LabelName, type MetricSpec,
} from './metrics.ts';
import { events } from './events.ts';

function walk(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  } catch { return []; }
}

/**
 * The 10k active-series cap is the binding constraint on the whole system
 * (OBSERVABILITY.md §5), and it is violated by a single careless label. The
 * types make that a compile error; these check the shape of the catalogue
 * itself, which types cannot.
 */

/**
 * DERIVED, not counted by hand.
 *
 * It used to be a literal table, and it had drifted: `via` was written as 5
 * against a union of 6 and `outcome` as 3 against 4, so the series budget below
 * — the check that stands between us and the 10,000-series cap — had been
 * quietly under-counting. A hand-maintained mirror of a union is a mirror that
 * goes stale; `metrics.ts` now proves the runtime sets are exhaustive at
 * compile time, which makes counting them the honest source.
 */
const LABEL_CARDINALITY: Record<LabelName, number> = cardinality;

test('no label repeats a value', () => {
  // Exhaustiveness is proven at compile time in metrics.ts; a duplicate is the
  // one thing that proof cannot see, and it would inflate the series budget
  // rather than shrink it — the safe direction, but still wrong.
  for (const [label, values] of Object.entries(labelValues)) {
    assert.equal(new Set(values).size, values.length, `${label} repeats a value`);
  }
});

test('every declared label is a closed set with known cardinality', () => {
  for (const [name, spec] of Object.entries(metrics) as [string, MetricSpec][]) {
    for (const label of spec.labels) {
      assert.ok(label in LABEL_CARDINALITY,
        `${name} declares label "${label}" with no known cardinality — if it is ` +
        `unbounded it must not be a metric label at all (§5)`);
    }
  }
});

test('total series stays well inside the 10,000 cap', () => {
  // service (3) and env (2) are applied by the sink as resource attributes, so
  // every metric is multiplied by them.
  const AMBIENT = 3 * 2;
  let series = 0;
  for (const spec of Object.values(metrics) as MetricSpec[]) {
    const combos = spec.labels.reduce((n, l) => n * LABEL_CARDINALITY[l], 1);
    series += combos * AMBIENT;
  }
  assert.ok(series < 3000,
    `${series} series from the metric catalogue alone; the cap is 10,000 and ` +
    `Phase 2 has not been written yet`);
});

test('no metric carries an identifier-shaped label', () => {
  // The failure §5 names explicitly: 100 actors x 150 chats is 15,000 series
  // for ONE metric. Belt and braces alongside the type-level guarantee.
  //
  // Matches a label that IS an entity or ends in _id — not merely one that
  // mentions an entity. `had_account` is a yes/no about whether local data
  // existed, which is exactly the kind of bounded label §5 wants; an earlier
  // version of this test rejected it, which would have pushed a legitimate
  // dimension out of the catalogue for looking wrong rather than being wrong.
  const ENTITIES = ['actor', 'chat', 'message', 'device', 'space',
                    'account', 'workspace', 'org', 'user', 'install'];
  for (const [name, spec] of Object.entries(metrics) as [string, MetricSpec][]) {
    // Widened deliberately. The types already make most of this unreachable —
    // tsc rejects `label === 'id'` as a comparison with no overlap — but the
    // catalogue is also validated at runtime on the server against telemetry
    // from clients we did not compile (§8, property 4), where no type applies.
    for (const label of spec.labels as readonly string[]) {
      assert.ok(!label.endsWith('_id') && label !== 'id',
        `${name} label "${label}" is an identifier`);
      assert.ok(!ENTITIES.includes(label),
        `${name} label "${label}" is an entity — its values are unbounded`);
      // client_version is the specific trap §5 calls out: opt-in updates mean
      // many live versions, multiplying EVERY metric carrying it.
      assert.notEqual(label, 'client_version', `${name} carries the version trap (§5)`);
    }
  }
});

test('every declared metric is actually recorded somewhere', () => {
  // The bug this exists for: `app.boot` was declared as a histogram and only
  // ever emitted as an event, so its dashboard panel returned zero series —
  // and an empty panel reads as "healthy", not as "never wired". Found by
  // querying the panel rather than by any test, which is why there is now one.
  const root = join(import.meta.dirname, '..', '..', '..');
  const sources = [
    join(root, 'apps', 'desktop', 'src'),
    join(root, 'apps', 'server', 'src'),
    join(root, 'packages', 'telemetry', 'src'),
  ].flatMap(d => walk(d));
  const code = sources
    .filter(f => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'))
    // The catalogue itself must be excluded, or every metric matches its own
    // declaration and the test can never fail. A negative control caught this:
    // a metric added with no call site passed. Instrumentation that measures
    // itself is the same mistake as a port-leak probe that opens ports.
    .filter(f => !f.endsWith('metrics.ts'))
    .map(f => readFileSync(f, 'utf8')).join('\n');

  const missing: string[] = [];
  for (const [name, spec] of Object.entries(metrics) as [string, MetricSpec][]) {
    if (spec.reserved) continue;
    if (!code.includes(`'${name}'`)) missing.push(name);
  }
  assert.deepEqual(missing, [],
    `declared but never recorded — mark as reserved:true if that is intended`);
});

test('every metric and event documents itself', () => {
  // §8: the catalogue doubles as documentation of what the system reports.
  // A metric's doc has to say what the number MEANS, since nobody reading a
  // dashboard six months from now has this file open.
  for (const [name, spec] of Object.entries(metrics) as [string, MetricSpec][]) {
    assert.ok(spec.doc.length > 30, `${name} needs a doc that explains the number`);
  }
  // Events are held to a shape rather than a length: several Phase 2 entries
  // are one honest line, and padding them to satisfy a threshold would make
  // the catalogue worse rather than better.
  for (const [name, spec] of Object.entries(events)) {
    assert.ok(spec.doc.trim().length > 0 && spec.doc.trim().endsWith('.'),
      `${name} needs a doc string`);
  }
});

test('events may carry ids — that is the whole point of the split', () => {
  // Metrics answer "how much"; events answer "which user". If no event carried
  // an id, nothing could be debugged down to a single person.
  const withIds = Object.values(events)
    .filter(e => Object.values(e.fields).includes('id')).length;
  assert.ok(withIds >= 8, `only ${withIds} events carry an id`);
});

test('no event can carry free text', () => {
  // The privacy control (§6): there is no field type a message body could use.
  const permitted = new Set(['id', 'int', 'ms', 'bool', 'enum']);
  for (const [name, spec] of Object.entries(events)) {
    for (const [field, type] of Object.entries(spec.fields)) {
      assert.ok(permitted.has(type), `${name}.${field} has type "${type}"`);
      assert.notEqual(field, 'body', `${name} has a body field`);
    }
  }
});
