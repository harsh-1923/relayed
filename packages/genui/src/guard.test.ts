// The library can only grow (docs/AGENT-RESPONSES.md, changing the library).
//
// The first test is the reason the rest exist: a reordered component leaves an
// already-stored block VALID and wrong. No error anywhere would ever say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { createLibrary, createParser, defineComponent } from '@openuidev/lang-core';
import { libraryShape, unsafeChanges, unsnapshotted, type LibraryShape } from './guard.ts';
import { library } from './library.ts';

const tone = z.enum(['neutral', 'success', 'warning', 'danger']);
const statLibrary = (props: z.ZodObject) => {
  const Stat = defineComponent({ name: 'Stat', description: 'x', props, component: null });
  const Card = defineComponent({ name: 'Card', description: 'x', component: null,
    props: z.object({ children: z.array(Stat.ref) }) });
  return createLibrary({ root: 'Card', components: [Card, Stat] });
};

const original = z.object({ label: z.string(), value: z.string(), tone: tone.optional() });
const stored = 'root = Card([s])\ns = Stat("Passed", "17", "success")';
const shapeOf = (props: z.ZodObject): LibraryShape => libraryShape(statLibrary(props).toJSONSchema());

test('why this exists: a reorder leaves a stored block valid, and saying something else', () => {
  const swapped = statLibrary(z.object({ value: z.string(), label: z.string(), tone: tone.optional() }));
  const parsed = createParser(swapped.toJSONSchema(), 'Card').parse(stored);
  assert.deepEqual(parsed.meta.errors, [], 'no validation error at all');
  const children = parsed.root?.props['children'] as Array<{ props: Record<string, unknown> }>;
  assert.equal(children[0]?.props['label'], '17');
  assert.equal(children[0]?.props['value'], 'Passed');
});

const cases: Array<[string, z.ZodObject, boolean]> = [
  ['an optional argument added at the end', z.object({ label: z.string(), value: z.string(), tone: tone.optional(), hint: z.string().optional() }), true],
  ['two arguments swapped', z.object({ value: z.string(), label: z.string(), tone: tone.optional() }), false],
  ['an argument removed', z.object({ label: z.string(), value: z.string() }), false],
  ['an enum value removed', z.object({ label: z.string(), value: z.string(), tone: z.enum(['neutral', 'success']).optional() }), false],
  ['an argument retyped', z.object({ label: z.string(), value: z.number(), tone: tone.optional() }), false],
  ['an optional argument made required', z.object({ label: z.string(), value: z.string(), tone }), false],
  ['a required argument added', z.object({ label: z.string(), value: z.string(), tone: tone.optional(), unit: z.string() }), false],
];

for (const [change, props, safe] of cases) {
  test(`${safe ? 'allowed' : 'refused'}: ${change}`, () => {
    const problems = unsafeChanges(shapeOf(original), shapeOf(props));
    assert.equal(problems.length === 0, safe, problems.join('; '));
  });
}

test('a removed component is refused', () => {
  const withoutStat: LibraryShape = { ...shapeOf(original) };
  delete withoutStat['Stat'];
  assert.deepEqual(unsafeChanges(shapeOf(original), withoutStat), ['Stat: removed']);
});

test('the real library changes nothing the snapshot locks', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../spec-snapshot.json', import.meta.url), 'utf8')) as LibraryShape;
  const current = libraryShape(library.toJSONSchema());
  assert.deepEqual(unsafeChanges(snapshot, current), [],
    'these changes would alter stored UI blocks — add a new component instead');
  assert.deepEqual(unsnapshotted(snapshot, current), [],
    'added to the library but not locked yet: run `pnpm --filter @relayed/genui snapshot`');
});
