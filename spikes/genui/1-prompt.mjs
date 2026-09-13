// Spike 1 — the library, its prompt, and the validator.
//
// Questions:
//   a. What does the generated prompt actually tell the model, with data and
//      state switched off? Does anything in it fight a coding agent's prose?
//   b. How large is it?
//   c. Does the validator catch the mistakes a model makes, and pass what is valid?
//   d. Is the plain-text rendering good enough for body / search / notifications?
import { mkdirSync, writeFileSync } from 'node:fs';
import { instructions, library, validateUi, formatForModel } from './library.mjs';

mkdirSync('results', { recursive: true });
// The recommended instructions: round two's rules included (docs/AGENT-RESPONSES.md, "The instructions").
const prompt = instructions({ preferBlocks: true });
writeFileSync('results/1-instructions.txt', prompt);

const lines = prompt.split('\n');
const mentions = term => lines.filter(line => line.includes(term)).length;
const report = {
  components: Object.keys(library.components).length,
  instructionChars: prompt.length,
  // ~3.6 chars/token for English prose plus code; spike 2 measures the real number.
  instructionTokensEstimate: Math.round(prompt.length / 3.6),
  mentionsOf: {
    'Query(': mentions('Query('),
    'Mutation(': mentions('Mutation('),
    '$': lines.filter(line => /\$[a-z]/.test(line)).length,
    '@ToAssistant': mentions('@ToAssistant'),
    'Action(': mentions('Action('),
    'openui-lang': mentions('openui-lang'),
    'ONLY': mentions('ONLY'),
    'markdown': lines.filter(line => /markdown/i.test(line)).length,
  },
};

const cases = {
  valid: [
    'root = Card([header, stats, files, next])',
    'header = CardHeader("catchup.test.ts is flaky", "3 of 20 runs failed")',
    'stats = Stack([passed, failed], "row")',
    'passed = Stat("Passed", "17", "success")',
    'failed = Stat("Failed", "3", "danger")',
    'files = Table([Col("File", ["catchup.ts", "catchup.test.ts"]), Col("Lines", ["432", "610"])])',
    'next = Actions([apply, why])',
    'apply = Reply("Apply the fix", "Apply the one-line fix", true)',
    'why = Link("CI run", "https://example.com/run/42")',
  ].join('\n'),
  forwardReferenceOrderIndependent: [
    'root = Card([note])',
    'note = Callout("warning", "Race", "close fires before catchup resolves")',
  ].join('\n'),
  unknownComponent: 'root = Card([x])\nx = Sparkline([1, 2, 3])',
  missingRequired: 'root = Card([s])\ns = Stat("Passed")',
  unresolvedReference: 'root = Card([header, missing])\nheader = CardHeader("Hi")',
  wrongRoot: 'root = Stack([s])\ns = Stat("A", "1")',
  truncatedMidStatement: 'root = Card([header])\nheader = CardHeader("catchup.test.ts is fl',
  queryNotAllowed: 'root = Card([t])\ndata = Query("list", {}, {rows: []})\nt = Table([Col("A", data.rows.a)])',
  stateNotAllowed: '$open = false\nroot = Card([t])\nt = Text("hello")',
  namedArgs: 'root = Card([s])\ns = Stat(label: "A", value: "1")',
  fenced: '```openui-lang\nroot = Card([t])\nt = Text("fenced")\n```',
  wrongEnum: 'root = Card([s])\ns = Stat("A", "1", "red")',
  jsonEscapedByMistake: 'root = Card([t])\\nt = Text(\\"escaped\\")',
};

report.validation = {};
for (const [name, source] of Object.entries(cases)) {
  const result = validateUi(source);
  report.validation[name] = {
    ok: result.ok,
    codes: result.errors.map(error => error.code),
    text: result.text.slice(0, 160),
  };
}
report.modelFacingErrorExample = formatForModel(validateUi(cases.unknownComponent).errors);

writeFileSync('results/1-prompt.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
