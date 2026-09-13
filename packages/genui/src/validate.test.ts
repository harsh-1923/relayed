// What a valid block is, one mistake at a time.
//
// Each case is a mistake a model makes or a rule the doc sets (docs/AGENT-RESPONSES.md,
// validation). The codes are what `show_ui` returns, so a model's repair depends on
// each one being produced — and on a valid block producing none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatForModel, validateUi, LIMITS } from './validate.ts';

const valid = [
  'root = Card([header, stats, files, next])',
  'header = CardHeader("catchup.test.ts is flaky", "3 of 20 runs failed")',
  'stats = Stack([passed, failed], "row")',
  'passed = Stat("Passed", "17", "success")',
  'failed = Stat("Failed", "3", "danger")',
  'files = Table([Col("File", ["catchup.ts", "catchup.test.ts"]), Col("Lines", ["432", "610"])])',
  'next = Actions([apply, run])',
  'apply = Reply("Apply the fix", "Apply the one-line fix", true)',
  'run = Link("CI run", "https://example.com/run/42")',
].join('\n');

const codesOf = (source: string): string[] => {
  const result = validateUi(source);
  return result.ok ? [] : result.errors.map(error => error.code);
};

test('a block using every kind of component is valid and yields its plain text', () => {
  const result = validateUi(valid);
  assert.equal(result.ok, true);
  assert.equal(result.text, [
    'catchup.test.ts is flaky: 3 of 20 runs failed',
    'Passed: 17 · Failed: 3',
    'File: catchup.ts, Lines: 432; File: catchup.test.ts, Lines: 610',
    '[Apply the fix] CI run <https://example.com/run/42>',
  ].join('\n'), 'body reads the data row by row, not just the headers');
});

test('a reference may be used before it is defined — streaming relies on it', () => {
  assert.deepEqual(codesOf('root = Card([note])\nnote = Callout("warning", "Race", "close fires first")'), []);
});

test('a fenced block is unwrapped rather than refused', () => {
  assert.deepEqual(codesOf('```openui-lang\nroot = Card([t])\nt = Text("fenced")\n```'), []);
});

const mistakes: Array<[string, string, string]> = [
  ['a component outside the library', 'root = Card([x])\nx = Sparkline([1, 2, 3])', 'unknown-component'],
  ['a required argument missing', 'root = Card([s])\ns = Stat("Passed")', 'missing-required'],
  ['a value outside an enum', 'root = Card([s])\ns = Stat("A", "1", "red")', 'type-mismatch'],
  ['named arguments, which the language does not have', 'root = Card([s])\ns = Stat(label: "A", value: "1")', 'excess-args'],
  ['a reference never defined', 'root = Card([header, missing])\nheader = CardHeader("Hi")', 'unresolved'],
  ['a definition nothing reaches', 'root = Card([a])\na = Text("shown")\nb = Text("lost")', 'orphaned'],
  ['a source cut off mid-statement', 'root = Card([h])\nh = CardHeader("catchup.test.ts is fl', 'incomplete'],
  ['a root that is not a Card', 'root = Stack([s])\ns = Stat("A", "1")', 'wrong-root'],
  ['a data query, which would run on every reader\'s machine', 'root = Card([t])\ndata = Query("list", {}, {rows: []})\nt = Table([Col("A", data.rows.a)])', 'data-not-allowed'],
  ['reactive state', '$open = false\nroot = Card([t])\nt = Text("hello")', 'state-not-allowed'],
  ['JSON escapes left in by mistake', 'root = Card([t])\\nt = Text(\\"escaped\\")', 'unresolved'],
];

for (const [what, source, code] of mistakes) {
  test(`refused: ${what} (${code})`, () => {
    assert.ok(codesOf(source).includes(code), `expected ${code}, got ${codesOf(source).join(', ')}`);
  });
}

test('an empty source is refused before parsing', () => {
  assert.deepEqual(codesOf('   '), ['empty']);
});

test('an oversized source is refused', () => {
  const huge = `root = Card([t])\nt = Text("${'x'.repeat(LIMITS.maxSourceBytes)}")`;
  assert.ok(codesOf(huge).includes('too-large'));
});

test('the error the model reads names the code, the statement and what to do', () => {
  const result = validateUi('root = Card([x])\nx = Sparkline([1])');
  assert.equal(result.ok, false);
  if (result.ok) return;
  const message = formatForModel(result.errors);
  assert.match(message, /^The UI block was not shown\. Fix these and call show_ui again:/);
  assert.match(message, /\[unknown-component\] "x":/);
  assert.match(message, /Available components: /, 'the parser lists what does exist, which is what a repair needs');
});

test('plain text survives a block that fails, for the renderer\'s fallback', () => {
  const result = validateUi('root = Card([h, bad])\nh = CardHeader("Before the bad line")\nbad = Sparkline([1])');
  assert.equal(result.ok, false);
  assert.equal(result.text, 'Before the bad line');
});
