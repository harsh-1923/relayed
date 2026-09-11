// The dashboards, checked against the catalogue.
//
// THE BUG THIS CLOSES, and it has already happened once. `app.boot` was
// declared as a histogram and only ever emitted as an event, so its panel
// returned zero series — and an empty panel reads as "healthy", not as "never
// wired". `metrics.test.ts` now catches that direction: declared, never
// recorded. This catches the other three, which nothing did:
//
//   a panel querying a metric name that does not exist
//   a panel filtering on a label value that is not in the closed set
//   a metric recorded and displayed nowhere
//
// All three fail the same silent way: a panel that is empty because it is
// wrong, which is indistinguishable from a panel that is empty because
// everything is fine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { metrics, labelValues, type MetricSpec } from './metrics.ts';
import { events } from './events.ts';

const DASHBOARDS = join(import.meta.dirname, '..', '..', '..',
                        'infra', 'grafana', 'dashboards');

interface Query { dashboard: string; panel: string; expr: string }

/** Every LogQL expression on every dashboard, with the panel it came from. */
function queries(): Query[] {
  const out: Query[] = [];
  for (const file of readdirSync(DASHBOARDS)) {
    if (!file.endsWith('.json')) continue;
    const dashboard = JSON.parse(readFileSync(join(DASHBOARDS, file), 'utf8')) as {
      panels: { title: string; targets?: { expr?: string }[] }[];
    };
    for (const panel of dashboard.panels) {
      for (const target of panel.targets ?? []) {
        if (target.expr) out.push({ dashboard: file, panel: panel.title, expr: target.expr });
      }
    }
  }
  return out;
}

test('the dashboards are found and parsed at all', () => {
  // A guard on the greps below. Point them at the wrong directory and every
  // other test here passes on an empty set, which is the same failure mode
  // they exist to catch.
  const found = queries();
  assert.ok(found.length > 30, `only ${found.length} queries found in ${DASHBOARDS}`);
});

test('every metric a panel queries is one the catalogue declares', () => {
  const declared = new Set(Object.keys(metrics));
  const wrong: string[] = [];
  for (const { dashboard, panel, expr } of queries()) {
    for (const [, name] of expr.matchAll(/metric_name="([a-z0-9._]+)"/g)) {
      if (!declared.has(name!)) wrong.push(`${dashboard} → "${panel}" → ${name}`);
    }
  }
  assert.deepEqual(wrong, [],
    'these panels can only ever be empty, which reads as healthy');
});

test('every event a panel queries is one the catalogue declares', () => {
  // Only exact matches. Several panels filter with a regex on purpose — one
  // stream of everything the engine reported — and a regex is not a name.
  const declared = new Set(Object.keys(events));
  const wrong: string[] = [];
  for (const { dashboard, panel, expr } of queries()) {
    for (const [, name] of expr.matchAll(/event_name="([a-z0-9._]+)"/g)) {
      if (!declared.has(name!)) wrong.push(`${dashboard} → "${panel}" → ${name}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('every label value a panel filters on is IN the closed set', () => {
  // The subtlest of the four. `frame="malformed"` is right and
  // `frame="malformed_body"` is wrong, and the only difference at runtime is a
  // panel that never moves.
  const known = new Map<string, readonly string[]>(
    Object.entries(labelValues).map(([label, values]) => [label, values]));
  const wrong: string[] = [];
  for (const { dashboard, panel, expr } of queries()) {
    for (const [, label, value] of expr.matchAll(/\|\s*([a-z_]+)="([a-z0-9._]+)"/g)) {
      const values = known.get(label!);
      // Unknown label names are skipped rather than failed: `metric_name`,
      // `event_name` and `service_name` are stream selectors, not metric labels.
      if (!values) continue;
      if (!values.includes(value!)) {
        wrong.push(`${dashboard} → "${panel}" → ${label}="${value}"`);
      }
    }
  }
  assert.deepEqual(wrong, []);
});

test('every SYNC metric is displayed somewhere', () => {
  // Step 13's criterion, from the other end: *a marker nobody reads costs
  // cardinality, ingest and attention*. Recording one and never showing it is
  // the same waste as declaring one and never recording it.
  //
  // Scoped to the sync catalogue rather than all of it, because twelve Phase 1
  // metrics are recorded and not on the Phase 1 dashboard — a real gap, and one
  // that belongs to Phase 1 rather than being fixed silently here.
  const shown = new Set<string>();
  for (const { expr } of queries()) {
    for (const [, name] of expr.matchAll(/metric_name="([a-z0-9._]+)"/g)) shown.add(name!);
  }
  const sync = Object.entries(metrics as Record<string, MetricSpec>)
    .filter(([name, spec]) => !spec.reserved &&
      (name.startsWith('sync.') || name.startsWith('outbox.') || name.startsWith('ws.')))
    .map(([name]) => name);

  assert.ok(sync.length >= 20, `only ${sync.length} sync metrics — check the prefixes`);
  assert.deepEqual(sync.filter(name => !shown.has(name)), [],
    'recorded, and on no dashboard');
});

test('a panel that names a unit uses one the metric declares', () => {
  // A histogram in milliseconds rendered as `short` is a chart of unlabelled
  // numbers, and a byte count rendered as `ms` is worse — it is a chart of
  // confidently wrong numbers.
  const wrong: string[] = [];
  for (const file of readdirSync(DASHBOARDS)) {
    if (!file.endsWith('.json')) continue;
    const dashboard = JSON.parse(readFileSync(join(DASHBOARDS, file), 'utf8')) as {
      panels: {
        title: string;
        targets?: { expr?: string }[];
        fieldConfig?: { defaults?: { unit?: string } };
      }[];
    };
    for (const panel of dashboard.panels) {
      const unit = panel.fieldConfig?.defaults?.unit;
      if (unit !== 'ms' && unit !== 'bytes') continue;
      for (const target of panel.targets ?? []) {
        for (const [, name] of (target.expr ?? '').matchAll(/metric_name="([a-z0-9._]+)"/g)) {
          const spec = (metrics as Record<string, MetricSpec>)[name!];
          if (spec && spec.unit !== unit) {
            wrong.push(`${file} → "${panel.title}" → ${name} is ${spec.unit ?? 'unitless'}, shown as ${unit}`);
          }
        }
      }
    }
  }
  assert.deepEqual(wrong, []);
});
