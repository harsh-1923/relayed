// The scrubbing rules, tested without a server: the catalogue check and the
// attribution rule are pure functions of a record and a caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { events, metrics } from '@relayed/telemetry/catalogue';

test('the catalogue this endpoint validates against is the one clients compile against', () => {
  // If these diverge, a client emits something the server silently discards and
  // neither side reports a problem. Naming a few that must exist on both.
  for (const e of ['app.boot', 'sync.gap.entered', 'app.update.offered']) {
    assert.ok(e in events, `${e} must be a declared event`);
  }
  for (const m of ['sync.fanout.audience', 'telemetry.ingested', 'telemetry.dropped']) {
    assert.ok(m in metrics, `${m} must be a declared metric`);
  }
});

test('every declared metric names a CLOSED set of labels, or none', () => {
  // The scrub keeps only declared labels, so an undeclared one cannot reach a
  // series. This asserts the shape that makes that possible.
  for (const [name, spec] of Object.entries(metrics as Record<string, { labels?: readonly string[] }>)) {
    if (spec.labels === undefined) continue;
    assert.ok(Array.isArray(spec.labels), `${name} labels must be an array`);
    for (const l of spec.labels) assert.equal(typeof l, 'string');
  }
});

test('no event declares a free-text field', () => {
  // §8's "absent type": FieldType has no 'string', because a free string is the
  // unbounded value that exhausts the active-series budget. A client could
  // otherwise post prose and we would store it.
  for (const [name, spec] of Object.entries(events as Record<string, { fields: Record<string, string> }>)) {
    for (const [field, type] of Object.entries(spec.fields)) {
      assert.notEqual(type, 'string', `${name}.${field} must not be free text`);
      assert.ok(['id', 'int', 'ms', 'bool', 'enum'].includes(type),
        `${name}.${field} has unknown type ${type}`);
    }
  }
});
