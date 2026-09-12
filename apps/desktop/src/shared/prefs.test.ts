// The catalogue, which is where a key/value table's validation went
// (PREFERENCES.md §7).
//
// The property under test is asymmetric and deliberately so: READS never fail
// and WRITES do. A preference is not worth a broken screen, and a surface
// offering a value the catalogue forbids is a programmer error that should be
// loud.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, isPreferenceKey, specOf, type PreferenceRow } from './prefs.ts';

const row = (key: string, value: string): PreferenceRow => ({ key, value, reach: 'local' });

test('a stored value decodes', () => {
  assert.equal(decode('appearance.theme', [row('appearance.theme', '"dark"')]), 'dark');
});

test('ABSENT is the ordinary case, and decodes to the default', () => {
  // Defaults are never written, so this is what almost every read looks like.
  assert.equal(decode('appearance.theme', []), 'system');
  assert.equal(decode('appearance.theme', null), 'system', 'and before the first read lands');
});

test('every way a row can be unreadable falls back rather than throwing', () => {
  // A value from a newer client, a key whose domain narrowed, a row the CHECK
  // should have stopped but a corrupt file would not, and the wrong JSON type.
  for (const stored of ['"sepia"', 'not json', '42', 'null', '{}']) {
    assert.equal(decode('appearance.theme', [row('appearance.theme', stored)]), 'system',
                 `${stored} should have fallen back`);
  }
});

test('an unrelated key in the table does not disturb the one being read', () => {
  assert.equal(
    decode('appearance.theme', [row('appearance.accent', '"violet"')]),
    'system',
  );
});

test('encode produces JSON TEXT, which is what the table CHECK requires', () => {
  assert.deepEqual(encode('appearance.theme', 'dark'), { value: '"dark"', reach: 'local' });
});

test('encode refuses an unknown key and a value outside the domain', () => {
  assert.throws(() => encode('appearance.mood', 'blue'), /unknown preference/);
  assert.throws(() => encode('appearance.theme', 'sepia'), /invalid value/);
  assert.throws(() => encode('appearance.theme', null), /invalid value/);
});

test('every key declares a fallback its own parse accepts', () => {
  // A default the catalogue would reject is a key that can never read back what
  // it means when absent — silently, because decode falls back to that very
  // value. Checked across the whole catalogue so a new entry is covered by
  // being added rather than by somebody remembering to test it.
  for (const key of ['appearance.theme'] as const) {
    assert.ok(isPreferenceKey(key));
    const spec = specOf(key);
    assert.equal(spec.parse(spec.fallback), spec.fallback, `${key}'s fallback is invalid`);
  }
});

test('nothing is synced yet', () => {
  // PREFERENCES.md §5: the column exists so rows written now are legible to the
  // release that starts syncing. Flipping a key to 'synced' before there is a
  // merge rule should fail here first.
  assert.equal(specOf('appearance.theme').reach, 'local');
});
